import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import { tiktokDeliveryStatus } from 'src/modules/ads/domain/platform/delivery-status';
import {
  AdsProviderGateway,
  AuthorizationContext,
  AuthorizationSubject,
  DateRange,
  ExternalAdAccount,
  MetricLevel,
  ProviderAd,
  ProviderAdSet,
  ProviderCampaign,
  ProviderCreative,
  ProviderFetchStep,
  ProviderMetricRow,
  ProviderStepFailure,
  ProviderSyncResult,
  ProviderTokenResult,
  SyncOptions,
} from 'src/modules/integrations/domain/ports';
import { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { UNKNOWN_OPTIMIZATION } from 'src/modules/integrations/domain/entities/optimization-target';
import {
  classifyTikTokAdGroup,
  classifyTikTokCampaign,
} from './tiktok-optimization';
import {
  planSmartPlusGapFill,
  SMART_PLUS_AD_PAGE_SIZE,
  SMART_PLUS_REPORT_METRICS,
  SMART_PLUS_REPORT_METRICS_MINIMAL,
  type SmartPlusAdNode,
  type SmartPlusGapFill,
  smartPlusMetricValues,
  smartPlusVideoIds,
  toSmartPlusAd,
  toSmartPlusCreative,
} from './tiktok-smart-plus';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';
const TIKTOK_AUTH_URL = 'https://business-api.tiktok.com/portal/auth';
const STATE_TTL = 60 * 10;

/** O maior `page_size` que listagens e relatório síncrono aceitam. */
const PAGE_SIZE = 1000;

/**
 * Teto de páginas por leitura. Não é limite de conta: é o que impede uma
 * `page_info` malformada de prender o worker num laço — e chegar nele vira
 * falha de etapa, nunca leitura "completa".
 */
const MAX_PAGES = 200;

/** Ids por filtro no refresh dirigido. */
const IDS_PER_FILTER = 100;

/** A série diária do anúncio Smart+ — o relatório padrão não a promete (D24). */
const SMART_PLUS_REPORT_PATH = '/smart_plus/material_report/breakdown/';

/** O maior lote de `video_ids` que `/file/video/ad/info/` aceita por chamada. */
const VIDEO_IDS_PER_BATCH = 60;

/**
 * O token de anunciante do Marketing API é de **longa duração**: não vence
 * sozinho, só por revogação. O fluxo gravava `expires_in ?? 86400` — um dia —, e
 * no dia seguinte o ingest tentava renovar um token sem `refresh_token`, levava
 * 401 e marcava a integração `TOKEN_EXPIRED`. Todo TikTok conectado caía em 24h.
 *
 * O vencimento gravado passa a ser uma **revalidação**: a cada 30 dias o token é
 * conferido contra a plataforma e, se ainda vale, ganha mais 30.
 */
const LONG_LIVED_REVALIDATION_MS = 30 * 24 * 60 * 60 * 1000;

const METRIC_FIELDS = [
  'spend',
  'impressions',
  'clicks',
  'ctr',
  'cpc',
  'conversion',
  'conversion_rate',
  'total_purchase_value',
  'cost_per_conversion',
  'frequency',
  'reach',
  'video_play_actions',
  'video_views_p100',
  'video_views_p25',
];

type ReportLevel = Exclude<MetricLevel, 'CREATIVE'>;

const REPORT_LEVEL: Record<
  ReportLevel,
  { dataLevel: string; dimension: string }
> = {
  CAMPAIGN: { dataLevel: 'AUCTION_CAMPAIGN', dimension: 'campaign_id' },
  ADSET: { dataLevel: 'AUCTION_ADGROUP', dimension: 'adgroup_id' },
  AD: { dataLevel: 'AUCTION_AD', dimension: 'ad_id' },
};

type TikTokEnvelope<T> = {
  code: number;
  message: string;
  data: T;
};

type TikTokPage<T> = {
  list?: T[];
  page_info?: { page?: number; total_page?: number };
};

type TikTokCampaignNode = {
  campaign_id: string;
  campaign_name: string;
  operation_status?: string;
  secondary_status?: string;
  objective_type?: string;
  budget?: number | string;
  budget_mode?: string;
  create_time?: string;
};

type TikTokAdGroupNode = {
  adgroup_id: string;
  adgroup_name: string;
  campaign_id: string;
  operation_status?: string;
  secondary_status?: string;
  optimization_goal?: string;
  /** O evento que o grupo otimiza — é o que a métrica `conversion` conta. */
  optimization_event?: string;
  billing_event?: string;
  budget?: number | string;
  budget_mode?: string;
};

type TikTokAdNode = {
  ad_id: string;
  ad_name: string;
  adgroup_id: string;
  campaign_id: string;
  operation_status?: string;
  secondary_status?: string;
  ad_text?: string;
  call_to_action?: string;
  image_ids?: string[];
  video_id?: string;
  landing_page_url?: string;
  ad_format?: string;
};

type TikTokReportRow = {
  dimensions?: Record<string, string>;
  metrics?: Record<string, string>;
};

/**
 * `/file/video/ad/info/` — o que resolve um `video_id` em algo mostrável.
 *
 * `video_cover_url` é o pôster que a Meta e o Google entregam de graça no nó do
 * criativo; o TikTok exige esta segunda chamada. `preview_url` é a única forma
 * de o extrator de frame (D7) ter uma URL http(s) reproduzível — sem ela,
 * `videoUrl` guardava um id opaco que `ffmpeg` sempre recusava.
 */
type TikTokVideoInfoNode = {
  video_id?: string;
  video_cover_url?: string;
  preview_url?: string;
};

/** Credentials proven present by `readConfig`. Every required field is a `string`. */
type TikTokAdsConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string;
};

@Injectable()
export class TikTokAdsProvider implements AdsProviderGateway {
  readonly platform: Platform = 'TIKTOK';
  private readonly logger = new Logger(TikTokAdsProvider.name);

  constructor(
    private readonly envService: EnvService,
    private readonly jwtService: JwtServiceInterface,
  ) {}

  /**
   * Same pattern as `GoogleAdsProvider` (PLAN.md D-5): `ensureConfigured()` proved
   * the credentials existed only by convention, so each read still typed as
   * `string | undefined` downstream. The validated bundle carries the guarantee.
   */
  private readonly requiredKeys = [
    'TIKTOK_ADS_CLIENT_ID',
    'TIKTOK_ADS_CLIENT_SECRET',
    'TIKTOK_ADS_REDIRECT_URI',
  ] as const;

  isConfigured(): boolean {
    return this.readConfig() !== null;
  }

  /** `null` when any required credential is missing or blank. */
  private readConfig(): TikTokAdsConfig | null {
    const values = this.requiredKeys.map((key) =>
      this.envService.get(key)?.trim(),
    );

    if (values.some((value) => !value)) return null;

    const [clientId, clientSecret, redirectUri] = values as [
      string,
      string,
      string,
    ];

    return {
      clientId,
      clientSecret,
      redirectUri,
      scopes: this.envService.get('TIKTOK_ADS_SCOPES')?.trim() || undefined,
    };
  }

  private requireConfig(): TikTokAdsConfig {
    const config = this.readConfig();

    if (!config) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'TikTok Ads provider is not configured',
      });
    }

    return config;
  }

  async getAuthorizationUrl(context: AuthorizationContext): Promise<string> {
    const config = this.requireConfig();
    const state = await this.jwtService.sign({
      sub: context.accountId,
      provider: 'TIKTOK',
      purpose: 'connect-integration',
      nonce: randomBytes(16).toString('hex'),
      organizationId: context.organizationId,
    });
    const url = new URL(TIKTOK_AUTH_URL);
    url.searchParams.set('app_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    if (config.scopes) url.searchParams.set('scope', config.scopes);
    return url.toString();
  }

  async exchangeCodeForToken(
    code: string,
    state: string,
  ): Promise<{
    token: ProviderTokenResult;
    accountId: string;
    organizationId: string | null;
  }> {
    const config = this.requireConfig();
    const { accountId, organizationId } = await this.validateState(state);

    const response = await fetch(`${TIKTOK_API}/oauth2/access_token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.clientId,
        secret: config.clientSecret,
        auth_code: code,
      }),
    });
    const env = (await response.json()) as TikTokEnvelope<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      advertiser_ids?: string[];
    }>;
    if (env.code !== 0 || !env.data?.access_token) {
      throw new BadGatewayException({
        code: 'TIKTOK_TOKEN_EXCHANGE_FAILED',
        message: env.message ?? 'TikTok auth failed',
      });
    }
    return {
      accountId,
      organizationId,
      token: {
        accessToken: env.data.access_token,
        refreshToken: env.data.refresh_token,
        expiresAt: new Date(
          Date.now() +
            (env.data.expires_in
              ? env.data.expires_in * 1000
              : LONG_LIVED_REVALIDATION_MS),
        ),
      },
    };
  }

  async refreshAccessToken(
    integration: Integration,
  ): Promise<ProviderTokenResult> {
    const config = this.requireConfig();

    /**
     * Sem `refresh_token` é o token de longa duração do anunciante: "renovar" é
     * confirmar que ele continua valendo. Recusar aqui — o que acontecia — era
     * declarar vencida uma credencial perfeitamente válida.
     */
    if (!integration.refreshToken) {
      await this.assertTokenStillValid(integration, config);

      return {
        accessToken: integration.accessToken,
        expiresAt: new Date(Date.now() + LONG_LIVED_REVALIDATION_MS),
      };
    }

    const response = await fetch(`${TIKTOK_API}/oauth2/refresh_token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.clientId,
        secret: config.clientSecret,
        refresh_token: integration.refreshToken,
      }),
    });
    const env = (await response.json()) as TikTokEnvelope<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    }>;
    if (env.code !== 0 || !env.data?.access_token) {
      throw new BadGatewayException({
        code: 'TIKTOK_TOKEN_REFRESH_FAILED',
        message: env.message ?? 'TikTok refresh failed',
      });
    }
    return {
      accessToken: env.data.access_token,
      refreshToken: env.data.refresh_token ?? integration.refreshToken,
      expiresAt: new Date(Date.now() + (env.data.expires_in ?? 86400) * 1000),
    };
  }

  async listAdAccounts(integration: Integration): Promise<ExternalAdAccount[]> {
    const config = this.requireConfig();
    const headers = this.headers(integration);

    // TikTok's advertiser/get expects app_id/secret as query params (their API,
    // not our choice), so this URL must never be logged.
    const advertisersUrl = new URL(`${TIKTOK_API}/oauth2/advertiser/get/`);
    advertisersUrl.searchParams.set('app_id', config.clientId);
    advertisersUrl.searchParams.set('secret', config.clientSecret);
    advertisersUrl.searchParams.set('access_token', integration.accessToken);

    const advertisersEnv = await this.get<{
      list?: Array<{ advertiser_id: string; advertiser_name: string }>;
    }>(advertisersUrl.toString(), headers);

    const advertisers = advertisersEnv.list ?? [];
    const accounts: ExternalAdAccount[] = [];
    for (const a of advertisers) {
      try {
        const info = await this.get<{
          list?: Array<{
            advertiser_id: string;
            name: string;
            currency: string;
            timezone: string;
            status: string;
          }>;
        }>(
          `${TIKTOK_API}/advertiser/info/?advertiser_ids=${encodeURIComponent(
            JSON.stringify([a.advertiser_id]),
          )}`,
          headers,
        );
        const detail = info.list?.[0];
        accounts.push({
          externalAccountId: a.advertiser_id,
          name: detail?.name ?? a.advertiser_name,
          currency: detail?.currency ?? 'USD',
          timezone: detail?.timezone ?? 'UTC',
          status: detail?.status ?? 'ACTIVE',
        });
      } catch (err) {
        this.logger.warn(
          `Skipping TikTok advertiser ${a.advertiser_id}: ${(err as Error).message}`,
        );
      }
    }
    return accounts;
  }

  async syncAdAccountMetrics(
    adAccount: AdAccount,
    integration: Integration,
    dateRange: DateRange,
    options?: SyncOptions,
  ): Promise<ProviderSyncResult> {
    // Confirms the provider is configured before doing any work; this path needs no
    // credential beyond the integration's own access token.
    this.requireConfig();
    const headers = this.headers(integration);
    const requestedLevels: MetricLevel[] = options?.levels ?? [
      'CAMPAIGN',
      'ADSET',
      'AD',
      'CREATIVE',
    ];

    const start = formatDate(dateRange.since);
    const end = formatDate(dateRange.until);

    // A2-S3: nenhuma leitura devolve `[]` sobre um erro. `stepFailures` é o que
    // torna a diferença observável — e a guarda de arquivamento de §8.2 só pode
    // decidir se o transporte souber dizer que não viu tudo.
    const failures: ProviderStepFailure[] = [];
    const source = { adAccount, headers, failures };

    /**
     * **Estrutura não é nível de métrica** — a lição da Meta (ver
     * `MetaAdsProvider.syncAdAccountMetrics`). Os grupos de anúncios estavam
     * atrás de `ADSET`, que o ingest nunca pede: todo anúncio do TikTok tem
     * `adgroup_id`, nenhum grupo chegava ao domínio, e a conta inteira ia para a
     * quarentena com `AD_SET_NOT_RESOLVED`.
     */
    const readsAdStructure =
      requestedLevels.includes('AD') || requestedLevels.includes('CREATIVE');
    const targetedIds = options?.adExternalIds ?? [];
    const targetedRefresh = targetedIds.length > 0;
    const readsAdGroupStructure =
      requestedLevels.includes('ADSET') ||
      (readsAdStructure && !targetedRefresh);

    const standardCampaigns = await this.readAllPages<TikTokCampaignNode>(
      source,
      'CAMPAIGNS',
      '/campaign/get/',
    );

    const standardAdGroups = readsAdGroupStructure
      ? await this.readAllPages<TikTokAdGroupNode>(
          source,
          'AD_SETS',
          '/adgroup/get/',
        )
      : [];

    const standardAds = readsAdStructure
      ? await this.readAds(source, targetedIds)
      : [];

    /**
     * **Smart+ pelas rotas próprias, só onde as padrão não chegam** (D24) —
     * atrás de `TIKTOK_SMART_PLUS_ENABLED`, desligado até a validação contra
     * conta real. A regra de lacunas mora em `tiktok-smart-plus.ts`.
     */
    const smartPlus =
      readsAdStructure && this.smartPlusEnabled()
        ? await this.readSmartPlus(source, {
            targetedIds,
            standardCampaigns,
            standardAdGroups,
            standardAds,
          })
        : null;

    const campaigns = [
      ...standardCampaigns,
      ...(smartPlus?.campaigns ?? []),
    ].map(toCampaign);
    const adSets = [...standardAdGroups, ...(smartPlus?.adGroups ?? [])].map(
      toAdGroup,
    );

    // O mesmo anúncio nas duas rotas vira **uma** unidade: a representação da
    // rota própria substitui a da padrão, nunca se soma a ela.
    const smartUnits = [
      ...(smartPlus?.replacements ?? []),
      ...(smartPlus?.additions ?? []),
    ];
    const replacedIds = new Set(
      (smartPlus?.replacements ?? []).map((ad) => String(ad.smart_plus_ad_id)),
    );
    const plainAds = standardAds
      .filter((node) => !replacedIds.has(String(node.ad_id)))
      .map(toAd);
    const ads = [...plainAds, ...smartUnits.map(toSmartPlusAd)];

    const creatives: ProviderCreative[] = requestedLevels.includes('CREATIVE')
      ? [
          ...(await this.adsToCreatives(source, plainAds)),
          ...(await this.smartPlusCreatives(source, smartUnits)),
        ]
      : [];

    const adsById = new Map(ads.map((ad) => [ad.externalAdId, ad]));
    const metrics: ProviderMetricRow[] = [];
    /** Anúncios que o relatório padrão já trouxe — a série não é lida duas vezes. */
    const reportedAdIds = new Set<string>();

    for (const level of reportLevelsFor(requestedLevels)) {
      const { dataLevel, dimension } = REPORT_LEVEL[level];

      const rows = await this.readAllPages<TikTokReportRow>(
        source,
        'INSIGHTS',
        '/report/integrated/get/',
        {
          report_type: 'BASIC',
          data_level: dataLevel,
          dimensions: JSON.stringify([dimension, 'stat_time_day']),
          metrics: JSON.stringify(METRIC_FIELDS),
          start_date: start,
          end_date: end,
        },
      );

      for (const row of rows) {
        const entityId = row.dimensions?.[dimension];
        const day = row.dimensions?.stat_time_day;
        if (!entityId || !day) continue;

        const values = row.metrics ?? {};

        // CREATIVE não tem relatório próprio: é o anúncio, como na Meta. Pedir
        // `AUCTION_AD` duas vezes gastava cota para receber a mesma resposta.
        const emitted: MetricLevel[] =
          level === 'AD'
            ? requestedLevels.filter((l) => l === 'AD' || l === 'CREATIVE')
            : [level];

        for (const emittedLevel of emitted) {
          metrics.push(
            this.toMetric(emittedLevel, entityId, day, values, adsById),
          );
        }
        if (level === 'AD') reportedAdIds.add(entityId);
      }
    }

    // A série do Smart+ pelo relatório próprio — só dos anúncios que a rota
    // padrão não enxergou **e** que o relatório padrão não trouxe.
    if (smartPlus) {
      metrics.push(
        ...(await this.readSmartPlusMetrics(source, {
          unitIds: smartPlus.additions
            .map((ad) => String(ad.smart_plus_ad_id))
            .filter((id) => !reportedAdIds.has(id)),
          window: { start, end },
          levels: requestedLevels,
          adsById,
        })),
      );
    }

    return {
      metrics,
      campaigns,
      adSets,
      ads,
      creatives,
      wasComplete: failures.length === 0,
      stepFailures: failures.length > 0 ? failures : undefined,
    };
  }

  /**
   * Revogação na plataforma, com a mesma semântica da Meta: melhor esforço. A
   * falha é registrada e a integração é desconectada aqui de qualquer forma.
   *
   * Era um no-op — o token de longa duração seguia valendo do lado do TikTok
   * depois de o usuário "desconectar", indefinidamente.
   */
  async revokeToken(integration: Integration): Promise<void> {
    const config = this.readConfig();
    if (!config) {
      this.logger.warn('Skipping TikTok revoke; provider not configured');
      return;
    }

    try {
      const response = await fetch(`${TIKTOK_API}/oauth2/revoke_token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: config.clientId,
          secret: config.clientSecret,
          access_token: integration.accessToken,
        }),
      });
      const env = (await response
        .json()
        .catch(() => null)) as TikTokEnvelope<unknown> | null;

      if (!response.ok || env?.code !== 0) {
        this.logger.warn(
          `TikTok revoke returned code=${env?.code ?? response.status}; marking integration disconnected anyway`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `TikTok revoke threw (${(error as Error).message}); marking integration disconnected anyway`,
      );
    }
  }

  // ---------------- helpers ----------------

  private headers(integration: Integration): Record<string, string> {
    return {
      'Access-Token': integration.accessToken,
      'Content-Type': 'application/json',
    };
  }

  private async get<T>(
    url: string,
    headers: Record<string, string>,
  ): Promise<T> {
    const response = await fetch(url, { method: 'GET', headers });
    const env = (await response.json()) as TikTokEnvelope<T>;
    if (env.code !== 0) {
      throw new BadGatewayException({
        code: 'TIKTOK_API_ERROR',
        message: env.message ?? `TikTok ${response.status}`,
      });
    }
    return env.data;
  }

  /**
   * Confere o token de longa duração contra a plataforma.
   *
   * A recusa sobe com a mensagem do TikTok para `RefreshIntegrationTokenUseCase`
   * decidir: "access token" inválido vira `TOKEN_EXPIRED`; limite de chamadas ou
   * falha do lado deles vira erro transitório, e o ciclo seguinte tenta de novo.
   */
  private async assertTokenStillValid(
    integration: Integration,
    config: TikTokAdsConfig,
  ): Promise<void> {
    const url = new URL(`${TIKTOK_API}/oauth2/advertiser/get/`);
    url.searchParams.set('app_id', config.clientId);
    url.searchParams.set('secret', config.clientSecret);
    url.searchParams.set('access_token', integration.accessToken);

    let env: TikTokEnvelope<unknown>;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.headers(integration),
      });
      env = (await response.json()) as TikTokEnvelope<unknown>;
    } catch (error) {
      throw new BadGatewayException({
        code: 'TIKTOK_TOKEN_CHECK_FAILED',
        message: `TikTok não respondeu à revalidação do token: ${(error as Error).message}`,
      });
    }

    if (env.code === 0) return;

    throw new BadGatewayException({
      code: 'TIKTOK_TOKEN_CHECK_FAILED',
      message: env.message ?? `TikTok recusou a revalidação (code ${env.code})`,
    });
  }

  /**
   * Percorre todas as páginas de uma listagem ou relatório.
   *
   * A versão anterior lia só a página 1 e declarava a leitura completa: numa
   * conta com mais de mil anúncios, o que passasse da primeira página era
   * **arquivado** pela guarda de §8.2, e a série dele parava de entrar. Uma
   * falha no meio devolve o que já veio, com a etapa marcada como falha — nunca
   * como completa.
   */
  private async readAllPages<T>(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    step: ProviderFetchStep,
    path: string,
    params: Record<string, string> = {},
    pageSize = PAGE_SIZE,
  ): Promise<T[]> {
    const items: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(`${TIKTOK_API}${path}`);
      url.searchParams.set('advertiser_id', source.adAccount.externalAccountId);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(pageSize));

      try {
        const data = await this.get<TikTokPage<T>>(
          url.toString(),
          source.headers,
        );
        const list = data?.list ?? [];
        items.push(...list);

        const totalPage = Number(data?.page_info?.total_page ?? 1);
        if (list.length === 0 || page >= totalPage) return items;
      } catch (error) {
        const message = (error as Error).message;
        this.logger.warn(
          `tiktok.fetch_failed step=${step} page=${page} advertiser=${source.adAccount.externalAccountId}: ${message}`,
        );
        source.failures.push({ step, message });
        return items;
      }
    }

    source.failures.push({
      step,
      message: `Leitura interrompida após ${MAX_PAGES} páginas de ${path}`,
    });
    return items;
  }

  /** O refresh dirigido lê só os anúncios pedidos, em lotes pelo filtro de ids. */
  private async readAds(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    targetedIds: string[],
  ): Promise<TikTokAdNode[]> {
    if (targetedIds.length === 0) {
      return this.readAllPages<TikTokAdNode>(source, 'ADS', '/ad/get/');
    }

    const ids = [...new Set(targetedIds)];
    const nodes: TikTokAdNode[] = [];

    for (let index = 0; index < ids.length; index += IDS_PER_FILTER) {
      nodes.push(
        ...(await this.readAllPages<TikTokAdNode>(source, 'ADS', '/ad/get/', {
          filtering: JSON.stringify({
            ad_ids: ids.slice(index, index + IDS_PER_FILTER),
          }),
        })),
      );
    }

    return nodes;
  }

  private smartPlusEnabled(): boolean {
    return this.envService.get('TIKTOK_SMART_PLUS_ENABLED') === true;
  }

  /**
   * O que as rotas `/smart_plus/*` acrescentam ao que as padrão já trouxeram.
   *
   * Falha aqui **é** falha de etapa: um anúncio que só esta leitura enxerga e
   * que ela deixou de trazer seria arquivado pela varredura completa.
   */
  private async readSmartPlus(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    input: {
      targetedIds: string[];
      standardCampaigns: TikTokCampaignNode[];
      standardAdGroups: TikTokAdGroupNode[];
      standardAds: TikTokAdNode[];
    },
  ): Promise<SmartPlusGapFill<TikTokCampaignNode, TikTokAdGroupNode>> {
    const standardAds = new Map(
      input.standardAds.map((ad) => [String(ad.ad_id), String(ad.campaign_id)]),
    );

    // Refresh dirigido: só os anúncios pedidos, e sem leitura de campanha.
    if (input.targetedIds.length > 0) {
      const smartAds = await this.readByIds<SmartPlusAdNode>(
        source,
        'ADS',
        '/smart_plus/ad/get/',
        'smart_plus_ad_ids',
        input.targetedIds,
        SMART_PLUS_AD_PAGE_SIZE,
      );

      return planSmartPlusGapFill({
        standardCampaignIds: new Set(),
        standardAdGroupIds: new Set(),
        standardAds,
        smartCampaigns: [],
        smartAdGroups: [],
        smartAds,
        targeted: true,
      });
    }

    const smartCampaigns = await this.readAllPages<TikTokCampaignNode>(
      source,
      'CAMPAIGNS',
      '/smart_plus/campaign/get/',
    );
    const smartCampaignIds = [
      ...new Set(
        smartCampaigns.map((campaign) => String(campaign.campaign_id)),
      ),
    ];

    const [smartAdGroups, smartAds] =
      smartCampaignIds.length === 0
        ? [[], []]
        : [
            await this.readByIds<TikTokAdGroupNode>(
              source,
              'AD_SETS',
              '/smart_plus/adgroup/get/',
              'campaign_ids',
              smartCampaignIds,
            ),
            await this.readByIds<SmartPlusAdNode>(
              source,
              'ADS',
              '/smart_plus/ad/get/',
              'campaign_ids',
              smartCampaignIds,
              SMART_PLUS_AD_PAGE_SIZE,
            ),
          ];

    const plan = planSmartPlusGapFill({
      standardCampaignIds: new Set(
        input.standardCampaigns.map((campaign) => String(campaign.campaign_id)),
      ),
      standardAdGroupIds: new Set(
        input.standardAdGroups.map((adGroup) => String(adGroup.adgroup_id)),
      ),
      standardAds,
      smartCampaigns,
      smartAdGroups,
      smartAds,
    });

    this.logger.log(
      `tiktok.smart_plus advertiser=${source.adAccount.externalAccountId} ` +
        `campanhas=${smartCampaignIds.length} acrescentadas=${plan.additions.length} ` +
        `substituidas=${plan.replacements.length} ignoradas=${plan.ignored}`,
    );

    return plan;
  }

  /** Uma listagem filtrada por ids, em lotes que o filtro aceita. */
  private async readByIds<T>(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    step: ProviderFetchStep,
    path: string,
    filterKey: string,
    ids: string[],
    pageSize = PAGE_SIZE,
  ): Promise<T[]> {
    const unique = [...new Set(ids)];
    const nodes: T[] = [];

    for (let index = 0; index < unique.length; index += IDS_PER_FILTER) {
      nodes.push(
        ...(await this.readAllPages<T>(
          source,
          step,
          path,
          {
            filtering: JSON.stringify({
              [filterKey]: unique.slice(index, index + IDS_PER_FILTER),
            }),
          },
          pageSize,
        )),
      );
    }

    return nodes;
  }

  /** O pacote de cada anúncio Smart+, com a miniatura do primeiro vídeo. */
  private async smartPlusCreatives(
    source: { adAccount: AdAccount; headers: Record<string, string> },
    units: SmartPlusAdNode[],
  ): Promise<ProviderCreative[]> {
    if (units.length === 0) return [];

    const firstVideos = [
      ...new Set(
        units
          .map((unit) => smartPlusVideoIds(unit)[0])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const videoInfo = await this.fetchVideoInfo(source, firstVideos);

    return units.map((unit) => toSmartPlusCreative(unit, videoInfo));
  }

  /**
   * A série diária de cada anúncio Smart+, uma consulta por anúncio: o
   * relatório por material não aceita o anúncio como dimensão, só como filtro,
   * então vários anúncios numa chamada viriam somados.
   */
  private async readSmartPlusMetrics(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    input: {
      unitIds: string[];
      window: { start: string; end: string };
      levels: MetricLevel[];
      adsById: Map<string, ProviderAd>;
    },
  ): Promise<ProviderMetricRow[]> {
    const emitted = input.levels.filter(
      (level) => level === 'AD' || level === 'CREATIVE',
    );
    if (emitted.length === 0) return [];

    const metrics: ProviderMetricRow[] = [];

    for (const unitId of input.unitIds) {
      const rows = await this.readSmartPlusDailyReport(
        source,
        unitId,
        input.window,
      );

      for (const row of rows) {
        const day = row.dimensions?.stat_time_day;
        if (!day) continue;
        const values = smartPlusMetricValues(row.metrics);

        for (const level of emitted) {
          metrics.push(
            this.toMetric(level, unitId, day, values, input.adsById),
          );
        }
      }
    }

    return metrics;
  }

  /**
   * Com a receita primeiro; se a versão recusar a consulta, relê só as quatro
   * mínimas — perder a receita é melhor que perder o gasto.
   */
  private async readSmartPlusDailyReport(
    source: {
      adAccount: AdAccount;
      headers: Record<string, string>;
      failures: ProviderStepFailure[];
    },
    unitId: string,
    window: { start: string; end: string },
  ): Promise<TikTokReportRow[]> {
    const params = (metrics: string[]) => ({
      dimensions: JSON.stringify(['stat_time_day']),
      metrics: JSON.stringify(metrics),
      start_date: window.start,
      end_date: window.end,
      filtering: JSON.stringify({ smart_plus_ad_ids: [unitId] }),
    });

    const probe: ProviderStepFailure[] = [];
    const rows = await this.readAllPages<TikTokReportRow>(
      { ...source, failures: probe },
      'INSIGHTS',
      SMART_PLUS_REPORT_PATH,
      params(SMART_PLUS_REPORT_METRICS),
      SMART_PLUS_AD_PAGE_SIZE,
    );
    if (probe.length === 0) return rows;

    this.logger.warn(
      `tiktok.smart_plus_report_narrowed advertiser=${source.adAccount.externalAccountId} ad=${unitId} — relendo sem a receita`,
    );

    return this.readAllPages<TikTokReportRow>(
      source,
      'INSIGHTS',
      SMART_PLUS_REPORT_PATH,
      params(SMART_PLUS_REPORT_METRICS_MINIMAL),
      SMART_PLUS_AD_PAGE_SIZE,
    );
  }

  private async adsToCreatives(
    source: { adAccount: AdAccount; headers: Record<string, string> },
    ads: ProviderAd[],
  ): Promise<ProviderCreative[]> {
    const videoIds = [
      ...new Set(
        ads
          .map((ad) => (ad.metadata?.video_id as string | undefined) ?? null)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const videoInfo = await this.fetchVideoInfo(source, videoIds);

    return ads.map((ad) => {
      const meta = ad.metadata ?? {};
      const videoId = (meta.video_id as string) ?? null;
      const info = videoId ? videoInfo.get(videoId) : undefined;

      return {
        externalCreativeId: ad.externalAdId,
        name: ad.name,
        title: ad.name,
        body: (meta.ad_text as string) ?? null,
        callToAction: (meta.call_to_action as string) ?? null,
        format: (meta.ad_format as string) ?? null,
        thumbnailUrl: info?.coverUrl ?? null,
        videoUrl: info?.previewUrl ?? null,
        imageUrl: Array.isArray(meta.image_ids)
          ? ((meta.image_ids as string[])[0] ?? null)
          : null,
        landingPageUrl: (meta.landing_page_url as string) ?? null,
      };
    });
  }

  /**
   * Resolve `video_id` → pôster e URL de preview, em lotes de
   * `VIDEO_IDS_PER_BATCH`.
   *
   * **Nunca entra em `source.failures`.** Miniatura e preview são conforto
   * sobre um criativo que já existe — o mesmo princípio de
   * `CreativeThumbnailService.backfill`: uma falha aqui marcaria `wasComplete
   * = false` na conta inteira e bloquearia o arquivamento de §8.2 por causa de
   * um pôster que não carregou. O criativo fica sem thumbnail/preview desta
   * vez, e o próximo sync tenta de novo.
   */
  private async fetchVideoInfo(
    source: { adAccount: AdAccount; headers: Record<string, string> },
    videoIds: string[],
  ): Promise<
    Map<string, { coverUrl: string | null; previewUrl: string | null }>
  > {
    const info = new Map<
      string,
      { coverUrl: string | null; previewUrl: string | null }
    >();
    if (videoIds.length === 0) return info;

    for (let index = 0; index < videoIds.length; index += VIDEO_IDS_PER_BATCH) {
      const batch = videoIds.slice(index, index + VIDEO_IDS_PER_BATCH);
      const url = new URL(`${TIKTOK_API}/file/video/ad/info/`);
      url.searchParams.set('advertiser_id', source.adAccount.externalAccountId);
      url.searchParams.set('video_ids', JSON.stringify(batch));

      try {
        const data = await this.get<{ list?: TikTokVideoInfoNode[] }>(
          url.toString(),
          source.headers,
        );
        for (const node of data.list ?? []) {
          if (!node.video_id) continue;
          info.set(node.video_id, {
            coverUrl: node.video_cover_url ?? null,
            previewUrl: node.preview_url ?? null,
          });
        }
      } catch (error) {
        this.logger.warn(
          `tiktok.video_info_failed advertiser=${source.adAccount.externalAccountId} ` +
            `lote=${batch.length}: ${(error as Error).message}`,
        );
      }
    }

    return info;
  }

  private toMetric(
    level: MetricLevel,
    entityId: string,
    day: string,
    m: Record<string, string>,
    adsById: Map<string, ProviderAd>,
  ): ProviderMetricRow {
    const spend = parseFloat(m.spend ?? '0') || 0;
    const impressions = parseInt(m.impressions ?? '0', 10) || 0;
    const clicks = parseInt(m.clicks ?? '0', 10) || 0;
    const conversions = parseFloat(m.conversion ?? '0') || 0;
    const revenue = parseFloat(m.total_purchase_value ?? '0') || 0;
    const refs: Pick<
      ProviderMetricRow,
      | 'campaignExternalId'
      | 'adSetExternalId'
      | 'adExternalId'
      | 'creativeExternalId'
    > = {
      campaignExternalId: null,
      adSetExternalId: null,
      adExternalId: null,
      creativeExternalId: null,
    };

    // Busca por mapa: com `Array.find` por linha, uma conta de 5 mil anúncios e
    // 30 dias fazia 750 milhões de comparações dentro do ingest.
    const ad = adsById.get(entityId);
    if (level === 'CAMPAIGN') refs.campaignExternalId = entityId;
    else if (level === 'ADSET') refs.adSetExternalId = entityId;
    else {
      refs.adExternalId = entityId;
      refs.adSetExternalId = ad?.adSetExternalId ?? null;
      refs.campaignExternalId = ad?.campaignExternalId ?? null;
      refs.creativeExternalId =
        level === 'CREATIVE' ? entityId : (ad?.creativeExternalId ?? null);
    }

    return {
      // `stat_time_day` chega como "2026-09-01 00:00:00". `new Date` sobre esse
      // formato interpreta no fuso **da máquina**: numa máquina em UTC-3 o dia
      // virava o anterior. Só a data importa, e ela é fixada em UTC.
      date: new Date(`${day.slice(0, 10)}T00:00:00.000Z`),
      level,
      externalEntityId: entityId,
      ...refs,
      spend,
      impressions,
      clicks,
      conversions,
      revenue,
      ctr: m.ctr ? parseFloat(m.ctr) : null,
      cpc: m.cpc ? parseFloat(m.cpc) : null,
      cpa: conversions > 0 ? spend / conversions : null,
      roas: spend > 0 && revenue > 0 ? revenue / spend : null,
      frequency: m.frequency ? parseFloat(m.frequency) : null,
      reach: m.reach ? parseInt(m.reach, 10) : null,
      videoViews: m.video_views_p100 ? parseInt(m.video_views_p100, 10) : null,
      engagement: null,
      thumbstopRate:
        m.video_play_actions && impressions > 0
          ? parseFloat(m.video_play_actions) / impressions
          : null,
      holdRate:
        m.video_views_p25 && m.video_views_p100
          ? parseFloat(m.video_views_p100) /
            Math.max(parseFloat(m.video_views_p25), 1)
          : null,
    };
  }

  private async validateState(state: string): Promise<AuthorizationSubject> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verify(state);
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_TIKTOK_STATE',
        message: 'TikTok OAuth state invalid',
      });
    }
    const issued = Number(payload.iat ?? 0);
    if (
      payload.provider !== 'TIKTOK' ||
      payload.purpose !== 'connect-integration' ||
      typeof payload.sub !== 'string' ||
      Math.floor(Date.now() / 1000) - issued > STATE_TTL
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_TIKTOK_STATE',
        message: 'TikTok OAuth state invalid or expired',
      });
    }
    return {
      accountId: payload.sub,
      // `state` anterior a esta mudança não carrega organização: o callback cai
      // no caminho antigo em vez de recusar quem já estava no meio do fluxo.
      organizationId:
        typeof payload.organizationId === 'string'
          ? payload.organizationId
          : null,
    };
  }
}

/** CREATIVE sai do relatório de anúncio; os demais níveis têm relatório próprio. */
function reportLevelsFor(levels: MetricLevel[]): ReportLevel[] {
  return [
    ...new Set(
      levels.map((level): ReportLevel => (level === 'CREATIVE' ? 'AD' : level)),
    ),
  ];
}

/**
 * Orçamento pelo `budget_mode`. O campo `budget` sozinho não diz se é diário:
 * `BUDGET_MODE_TOTAL` é o total do voo, e lê-lo como diário fazia o ritmo de
 * orçamento comparar o gasto de um dia com o teto da campanha inteira.
 * `BUDGET_MODE_INFINITE` não tem teto a afirmar.
 */
function budgetOf(
  mode: string | undefined,
  amount: unknown,
): { dailyBudget: number | null; lifetimeBudget: number | null } {
  const value = Number(amount);
  const positive = Number.isFinite(value) && value > 0 ? value : null;

  switch (mode) {
    case 'BUDGET_MODE_DAY':
    case 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET':
      return { dailyBudget: positive, lifetimeBudget: null };
    case 'BUDGET_MODE_TOTAL':
      return { dailyBudget: null, lifetimeBudget: positive };
    default:
      return { dailyBudget: null, lifetimeBudget: null };
  }
}

/**
 * A v1.3 expõe `operation_status` e `secondary_status` — não `status`. O ingest
 * lia `status`, que não vem: todo objeto do TikTok entrava com status nulo, e
 * todo anúncio virava `UNKNOWN`.
 */
function toCampaign(node: TikTokCampaignNode): ProviderCampaign {
  return {
    externalCampaignId: String(node.campaign_id),
    name: node.campaign_name,
    status: tiktokDeliveryStatus({
      operationStatus: node.operation_status,
      secondaryStatus: node.secondary_status,
    }),
    objective: node.objective_type ?? null,
    optimization: classifyTikTokCampaign(node.objective_type),
    ...budgetOf(node.budget_mode, node.budget),
    currency: null,
    startedAt: parseTikTokTime(node.create_time),
    endedAt: null,
    metadata: { budgetMode: node.budget_mode ?? null },
  };
}

function toAdGroup(node: TikTokAdGroupNode): ProviderAdSet {
  return {
    externalAdSetId: String(node.adgroup_id),
    campaignExternalId: String(node.campaign_id),
    name: node.adgroup_name,
    status: tiktokDeliveryStatus({
      operationStatus: node.operation_status,
      secondaryStatus: node.secondary_status,
    }),
    optimizationGoal: node.optimization_goal ?? null,
    // `UNKNOWN` explícito quando a meta não diz nada: o anúncio resolve pelo
    // objetivo da campanha.
    optimization:
      classifyTikTokAdGroup({
        optimizationGoal: node.optimization_goal,
        optimizationEvent: node.optimization_event,
      }) ?? UNKNOWN_OPTIMIZATION,
    billingEvent: node.billing_event ?? null,
    ...budgetOf(node.budget_mode, node.budget),
    metadata: { budgetMode: node.budget_mode ?? null },
  };
}

function toAd(node: TikTokAdNode): ProviderAd {
  return {
    externalAdId: String(node.ad_id),
    adSetExternalId: String(node.adgroup_id),
    campaignExternalId: String(node.campaign_id),
    creativeExternalId: String(node.ad_id),
    name: node.ad_name,
    status: tiktokDeliveryStatus({
      operationStatus: node.operation_status,
      secondaryStatus: node.secondary_status,
    }),
    metadata: {
      ad_text: node.ad_text,
      call_to_action: node.call_to_action,
      image_ids: node.image_ids,
      video_id: node.video_id,
      landing_page_url: node.landing_page_url,
      ad_format: node.ad_format,
    },
  };
}

/** "YYYY-MM-DD HH:MM:SS" do TikTok é UTC; sem o `Z`, `Date` usaria o fuso local. */
function parseTikTokTime(value: string | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
