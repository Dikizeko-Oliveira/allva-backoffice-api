import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import {
  AdsProviderGateway,
  AuthorizationContext,
  AuthorizationSubject,
  DateRange,
  ExternalAdAccount,
  MetricLevel,
  ProviderAd,
  ProviderAdSet,
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
import { fromMinorUnits } from 'src/shared/domain/money';
import { UNKNOWN_OPTIMIZATION } from 'src/modules/integrations/domain/entities/optimization-target';
import {
  countMetaConversions,
  resolveMetaAdSetOptimization,
  resolveMetaCampaignOptimization,
  type MetaConversionSpec,
  type MetaPromotedObject,
} from './meta-conversion-events';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

const META_STATE_TTL_SECONDS = 60 * 10;
const META_SCOPES = ['ads_management', 'ads_read', 'business_management'];

type MetaTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

/** Credentials proven present by `readConfig`. Every field is a real `string`. */
type MetaAdsConfig = {
  appId: string;
  appSecret: string;
  callbackUrl: string;
};

type MetaErrorResponse = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    fbtrace_id?: string;
  };
};

type MetaAdAccountNode = {
  id: string;
  account_id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  business_name?: string;
};

type MetaInsightsRow = {
  date_start: string;
  date_stop: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  frequency?: string;
  reach?: string;
  inline_link_clicks?: string;
  unique_clicks?: string;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  video_thruplay_watched_actions?: Array<{
    action_type: string;
    value: string;
  }>;
  video_p100_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p25_watched_actions?: Array<{ action_type: string; value: string }>;
  video_play_actions?: Array<{ action_type: string; value: string }>;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  ad_id?: string;
};

type MetaCampaignNode = {
  id: string;
  name: string;
  status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  stop_time?: string;
};

type MetaAdSetNode = {
  id: string;
  name: string;
  status?: string;
  campaign_id: string;
  optimization_goal?: string;
  /** Qual evento a meta otimiza — é daqui que sai o que conta como conversão. */
  promoted_object?: MetaPromotedObject;
  billing_event?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  targeting?: Record<string, unknown>;
  start_time?: string;
  end_time?: string;
};

type MetaAdNode = {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  updated_time?: string;
  adset_id: string;
  campaign_id: string;
  creative?: { id: string };
};

type MetaCreativeNode = {
  id: string;
  name?: string;
  title?: string;
  body?: string;
  call_to_action_type?: string;
  object_type?: string;
  thumbnail_url?: string;
  video_id?: string;
  image_url?: string;
  object_story_spec?: {
    link_data?: { link?: string };
    video_data?: { call_to_action?: { value?: { link?: string } } };
  };
};

/**
 * O resultado de percorrer um edge paginado.
 *
 * `complete: false` **não** é erro: é a informação de que a leitura não cobriu o
 * escopo, e é ela que o ingest converte em "não arquiva nada" (§8.2 passo 9).
 * Antes de A2-S3, uma falha aqui devolvia `[]` — e lista vazia é uma afirmação
 * sobre a conta do usuário, não sobre a chamada.
 */
type MetaPage<T> = {
  items: T[];
  complete: boolean;
  failure?: ProviderStepFailure;
};

function emptyPage<T>(): Promise<MetaPage<T>> {
  return Promise.resolve({ items: [], complete: true });
}

/** O conjunto como o domínio o recebe, mais o que contar como conversão nele. */
type MetaAdSetRead = ProviderAdSet & {
  conversionSpec: MetaConversionSpec | null;
};

function withoutSpec(adSet: MetaAdSetRead): ProviderAdSet {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { conversionSpec, ...rest } = adSet;
  return rest;
}

/**
 * Estrutura incremental (§8.2 passo 4). O Graph filtra por `updated_time` no
 * mesmo parâmetro `filtering` que já usamos para ids, então os dois casos não se
 * sobrepõem: refresh dirigido manda ids, ingest incremental manda data.
 */
function applyUpdatedSince(
  url: URL,
  entity: 'campaign' | 'adset' | 'ad',
  updatedSince?: Date | null,
): void {
  if (!updatedSince) return;

  url.searchParams.set(
    'filtering',
    JSON.stringify([
      {
        field: `${entity}.updated_time`,
        operator: 'GREATER_THAN',
        value: Math.floor(updatedSince.getTime() / 1000),
      },
    ]),
  );
}

@Injectable()
export class MetaAdsProvider implements AdsProviderGateway {
  readonly platform: Platform = 'META';

  private readonly logger = new Logger(MetaAdsProvider.name);

  constructor(
    private readonly envService: EnvService,
    private readonly jwtService: JwtServiceInterface,
  ) {}

  /**
   * Same pattern as the Google and TikTok providers (PLAN.md D-5/D-2): a validated
   * bundle instead of an `ensureConfigured()` that only guaranteed things by
   * convention. These credentials became optional in the schema, so the type system
   * now has to be the thing that stops a blank one reaching Facebook.
   */
  private readonly requiredKeys = [
    'META_APP_ID',
    'META_APP_SECRET',
    'META_CALLBACK_URL',
  ] as const;

  /**
   * A versão da Graph API usada em **toda** chamada — OAuth, leitura e, a partir
   * de A2-S7, escrita.
   *
   * Era `const META_API_VERSION = 'v19.0'` no topo do arquivo, e v19.0 expirou
   * em 21/05/2026. O problema não foi o número estar velho: foi ele estar num
   * lugar onde ninguém olha até algo quebrar. Uma versão que caduca sozinha é
   * configuração, não constante.
   */
  private get apiVersion(): string {
    return this.envService.get('META_API_VERSION');
  }

  isConfigured(): boolean {
    return this.readConfig() !== null;
  }

  /** `null` when any required credential is missing or blank. */
  private readConfig(): MetaAdsConfig | null {
    const values = this.requiredKeys.map((key) =>
      this.envService.get(key)?.trim(),
    );

    if (values.some((value) => !value)) return null;

    const [appId, appSecret, callbackUrl] = values as [string, string, string];

    return { appId, appSecret, callbackUrl };
  }

  private requireConfig(): MetaAdsConfig {
    const config = this.readConfig();

    if (!config) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'Meta Ads provider is not configured',
      });
    }

    return config;
  }

  async getAuthorizationUrl(context: AuthorizationContext): Promise<string> {
    const config = this.requireConfig();

    const state = await this.jwtService.sign({
      sub: context.accountId,
      provider: 'META',
      purpose: 'connect-integration',
      nonce: randomBytes(16).toString('hex'),
      organizationId: context.organizationId,
    });

    const url = new URL(
      `https://www.facebook.com/${this.apiVersion}/dialog/oauth`,
    );
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', META_SCOPES.join(','));

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
    // Gate only: the credentials themselves are read by the private helpers, which
    // call `requireConfig()` in their own right.
    this.requireConfig();

    const { accountId, organizationId } = await this.validateState(state);

    const shortLived = await this.exchangeAuthorizationCode(code);
    const longLived = await this.exchangeForLongLivedToken(
      shortLived.access_token,
    );

    return {
      accountId,
      organizationId,
      token: {
        accessToken: longLived.access_token,
        expiresAt: new Date(Date.now() + longLived.expires_in * 1000),
      },
    };
  }

  async refreshAccessToken(
    integration: Integration,
  ): Promise<ProviderTokenResult> {
    // Gate only: the credentials themselves are read by the private helpers, which
    // call `requireConfig()` in their own right.
    this.requireConfig();

    // Meta long-lived tokens are refreshed by re-exchanging the existing token
    const refreshed = await this.exchangeForLongLivedToken(
      integration.accessToken,
    );

    return {
      accessToken: refreshed.access_token,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    };
  }

  async listAdAccounts(integration: Integration): Promise<ExternalAdAccount[]> {
    // Gate only: the credentials themselves are read by the private helpers, which
    // call `requireConfig()` in their own right.
    this.requireConfig();

    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/me/adaccounts`,
    );
    url.searchParams.set(
      'fields',
      'id,account_id,name,currency,timezone_name,account_status,business_name',
    );
    url.searchParams.set('limit', '100');
    url.searchParams.set('access_token', integration.accessToken);

    const response = await fetch(url, { method: 'GET' });
    const body = (await response.json()) as MetaErrorResponse & {
      data?: MetaAdAccountNode[];
    };

    if (!response.ok || !Array.isArray(body.data)) {
      this.throwGraphError(
        'META_LIST_AD_ACCOUNTS_FAILED',
        body,
        response.status,
      );
    }

    return (body.data ?? []).map((node) => ({
      externalAccountId: node.id,
      name: node.name ?? node.account_id,
      currency: node.currency ?? 'USD',
      timezone: node.timezone_name ?? 'UTC',
      status: this.mapAccountStatus(node.account_status),
      metadata: {
        accountIdRaw: node.account_id,
        businessName: node.business_name,
      },
    }));
  }

  async syncAdAccountMetrics(
    adAccount: AdAccount,
    integration: Integration,
    dateRange: DateRange,
    options?: SyncOptions,
  ): Promise<ProviderSyncResult> {
    // Gate only: the credentials themselves are read by the private helpers, which
    // call `requireConfig()` in their own right.
    this.requireConfig();

    const since = formatDate(dateRange.since);
    const until = formatDate(dateRange.until);
    const requestedLevels: MetricLevel[] = options?.levels ?? [
      'CAMPAIGN',
      'ADSET',
      'AD',
      'CREATIVE',
    ];

    // A2-S3: cada etapa reporta sucesso ou falha em vez de devolver lista vazia.
    // Antes, um 403 em `/ads` produzia `[]` — indistinguível de "esta conta não
    // tem anúncios" — e o ingest concluiria que tudo sumiu. É exatamente a
    // leitura que a guarda de arquivamento de §8.2 existe para impedir, e ela só
    // funciona se o transporte souber declarar que não viu tudo.
    const failures: ProviderStepFailure[] = [];

    const metrics: ProviderMetricRow[] = [];
    const insightRows: Array<{ row: MetaInsightsRow; level: MetricLevel }> = [];
    const levelToMeta: Record<MetricLevel, string | null> = {
      CAMPAIGN: 'campaign',
      ADSET: 'adset',
      AD: 'ad',
      CREATIVE: null,
    };

    for (const level of requestedLevels) {
      const apiLevel = levelToMeta[level];
      if (!apiLevel) continue;
      const page = await this.fetchInsights(
        adAccount,
        integration,
        since,
        until,
        apiLevel,
        options,
      );
      if (page.failure) failures.push(page.failure);
      // A linha só vira métrica depois da estrutura: o que conta como conversão
      // depende do evento que o conjunto dela otimiza.
      for (const row of page.items) insightRows.push({ row, level });
    }

    const readsAdStructure =
      requestedLevels.includes('AD') || requestedLevels.includes('CREATIVE');

    /**
     * **Estrutura não é nível de métrica**, e confundir as duas custava a conta
     * inteira.
     *
     * `levels` diz de que nível se pede *insights*, e o ingest pede
     * `['AD', 'CREATIVE']` de propósito: só o nível AD vai para o armazenamento
     * (§8.2 passo 6), e ler também a linha do conjunto é a classe de bug de
     * dupla contagem que a v2 existe para eliminar.
     *
     * `fetchAdSets` estava atrás desse mesmo `levels` — então o ingest nunca
     * lia conjunto nenhum. Todo anúncio da Meta tem `adset_id`; sem o conjunto
     * no domínio, `unresolvedReason` devolve `AD_SET_NOT_RESOLVED` e **cada
     * anúncio da conta vai para a quarentena**. Campanha e criativo entram,
     * anúncio e série não, e o produto fica mudo sobre uma conta que sincroniza
     * com saúde `HEALTHY` — o sintoma mais caro que este arquivo já produziu.
     *
     * `fetchCampaigns` já era incondicional pela mesma razão: são os pais que o
     * anúncio precisa ter resolvidos para existir. O conjunto passa ao mesmo pé.
     *
     * A exceção é o refresh dirigido (②): ele manda ids de anúncios que **já
     * existem** no domínio, com o conjunto resolvido no banco — `upsertAdSets`
     * parte de `mapAdSetIds`, não do payload. Reler a hierarquia inteira por
     * causa deles gastaria a cota que R4 protege para as escritas.
     */
    const targetedRefresh = Boolean(options?.adExternalIds?.length);
    const readsAdSetStructure =
      requestedLevels.includes('ADSET') ||
      (readsAdStructure && !targetedRefresh);

    const [campaignsPage, adSetsPage, adsPage, creativesPage] =
      await Promise.all([
        this.fetchCampaigns(adAccount, integration, options),
        readsAdSetStructure
          ? this.fetchAdSets(adAccount, integration, options)
          : emptyPage<MetaAdSetRead>(),
        readsAdStructure
          ? this.fetchAds(adAccount, integration, options)
          : emptyPage<ProviderAd>(),
        requestedLevels.includes('CREATIVE')
          ? this.fetchCreatives(adAccount, integration)
          : emptyPage<ProviderCreative>(),
      ]);

    for (const page of [campaignsPage, adSetsPage, adsPage, creativesPage]) {
      if (page.failure) failures.push(page.failure);
    }

    const campaigns = campaignsPage.items;
    const adSets = adSetsPage.items.map(withoutSpec);
    const ads = adsPage.items;
    const creatives = creativesPage.items;

    /**
     * O evento de cada linha: o do conjunto, e o do objetivo da campanha quando
     * o conjunto não declara meta.
     *
     * O refresh dirigido não lê a hierarquia (ver acima) — mas precisa do evento
     * dos conjuntos envolvidos, ou contaria compra num anúncio de lead. Uma
     * leitura filtrada pelos ids que as linhas trouxeram resolve com uma chamada.
     */
    const specByAdSet = new Map(
      adSetsPage.items.map((adSet) => [
        adSet.externalAdSetId,
        adSet.conversionSpec,
      ]),
    );
    if (targetedRefresh) {
      const missing = [
        ...new Set(
          insightRows
            .map(({ row }) => row.adset_id)
            .filter(
              (id): id is string =>
                typeof id === 'string' && id !== '' && !specByAdSet.has(id),
            ),
        ),
      ];
      for (const adSet of await this.fetchAdSetSpecs(
        adAccount,
        integration,
        missing,
      )) {
        specByAdSet.set(adSet.externalAdSetId, adSet.conversionSpec);
      }
    }
    const specByCampaign = new Map(
      campaigns.map((campaign) => [
        campaign.externalCampaignId,
        resolveMetaCampaignOptimization(campaign.objective),
      ]),
    );

    for (const { row, level } of insightRows) {
      const spec =
        (row.adset_id ? specByAdSet.get(row.adset_id) : null) ??
        (row.campaign_id ? specByCampaign.get(row.campaign_id) : null) ??
        null;
      metrics.push(this.mapInsightRow(row, level, spec));
    }

    // Derive CREATIVE-level metrics by aggregating ad-level metrics under their creative id
    if (requestedLevels.includes('CREATIVE') && ads.length > 0) {
      const adToCreative = new Map<string, string | null>();
      for (const ad of ads) {
        adToCreative.set(ad.externalAdId, ad.creativeExternalId ?? null);
      }
      const adMetrics = metrics.filter((m) => m.level === 'AD');
      const grouped = new Map<string, ProviderMetricRow>();
      for (const m of adMetrics) {
        const creativeId = adToCreative.get(m.externalEntityId);
        if (!creativeId) continue;
        const key = `${m.date.toISOString().slice(0, 10)}::${creativeId}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.spend += m.spend;
          existing.impressions += m.impressions;
          existing.clicks += m.clicks;
          existing.conversions += m.conversions;
          existing.revenue += m.revenue;
        } else {
          grouped.set(key, {
            date: m.date,
            level: 'CREATIVE',
            externalEntityId: creativeId,
            campaignExternalId: m.campaignExternalId ?? null,
            adSetExternalId: m.adSetExternalId ?? null,
            adExternalId: m.adExternalId ?? null,
            creativeExternalId: creativeId,
            spend: m.spend,
            impressions: m.impressions,
            clicks: m.clicks,
            conversions: m.conversions,
            revenue: m.revenue,
            ctr: null,
            cpc: null,
            cpa: null,
            roas: null,
            frequency: m.frequency ?? null,
            reach: m.reach ?? null,
            videoViews: m.videoViews ?? null,
            engagement: m.engagement ?? null,
            thumbstopRate: m.thumbstopRate ?? null,
            holdRate: m.holdRate ?? null,
          });
        }
      }
      for (const m of grouped.values()) {
        m.ctr = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null;
        m.cpc = m.clicks > 0 ? m.spend / m.clicks : null;
        m.cpa = m.conversions > 0 ? m.spend / m.conversions : null;
        m.roas = m.spend > 0 ? m.revenue / m.spend : null;
        metrics.push(m);
      }
    }

    return {
      metrics,
      campaigns,
      adSets,
      ads,
      creatives,
      // Declarado, nunca inferido: só uma leitura sem nenhuma falha de etapa
      // autoriza o ingest a arquivar o que não veio (§8.2 passo 9).
      wasComplete: failures.length === 0,
      stepFailures: failures.length > 0 ? failures : undefined,
    };
  }

  /**
   * Percorre todas as páginas de um edge do Graph, reportando falha em vez de
   * devolver silêncio.
   *
   * Uma falha **no meio** da paginação devolve o que já veio com
   * `complete: false`: descartar as páginas lidas gastaria a cota de novo na
   * próxima janela, e fingir que estão completas arquivaria o resto da conta.
   */
  private async fetchAllPages<T>(
    step: ProviderFetchStep,
    firstUrl: string,
    errorContext: string,
  ): Promise<MetaPage<T>> {
    const items: T[] = [];
    let next: string | null = firstUrl;

    while (next) {
      let response: Response;
      try {
        response = await fetch(next, { method: 'GET' });
      } catch (error) {
        return {
          items,
          complete: false,
          failure: {
            step,
            message: `${errorContext}: ${(error as Error).message}`,
            status: null,
          },
        };
      }

      const body = (await response.json().catch(() => ({}))) as
        | (MetaErrorResponse & { data?: T[]; paging?: { next?: string } })
        | Record<string, never>;

      if (!response.ok || !Array.isArray(body.data)) {
        this.logger.warn(
          `meta.fetch_failed step=${step} ${errorContext} status=${response.status}`,
        );
        return {
          items,
          complete: false,
          failure: {
            step,
            message:
              body.error?.message ?? `${errorContext} respondeu sem dados`,
            status: response.status,
          },
        };
      }

      items.push(...body.data);
      next = body.paging?.next ?? null;
    }

    return { items, complete: true };
  }

  private async fetchInsights(
    adAccount: AdAccount,
    integration: Integration,
    since: string,
    until: string,
    apiLevel: string,
    options?: SyncOptions,
  ): Promise<MetaPage<MetaInsightsRow>> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/insights`,
    );
    url.searchParams.set(
      'fields',
      'spend,impressions,clicks,ctr,cpc,frequency,reach,actions,action_values,cost_per_action_type,campaign_id,campaign_name,adset_id,ad_id,video_thruplay_watched_actions,video_p100_watched_actions,video_p25_watched_actions,video_play_actions,inline_link_clicks,unique_clicks',
    );
    url.searchParams.set('level', apiLevel);
    url.searchParams.set('time_increment', '1');
    url.searchParams.set('time_range', JSON.stringify({ since, until }));
    url.searchParams.set('limit', '500');
    // ② Refresh dirigido (§8.3): um lote de ids vira **uma** chamada de insights,
    // e não uma por anúncio — é o que mantém o orçamento de R4 de pé quando a
    // tela pede atualização de trinta anúncios de uma vez.
    if (apiLevel === 'ad' && options?.adExternalIds?.length) {
      url.searchParams.set(
        'filtering',
        JSON.stringify([
          {
            field: 'ad.id',
            operator: 'IN',
            value: options.adExternalIds,
          },
        ]),
      );
    }
    url.searchParams.set('access_token', integration.accessToken);

    return this.fetchAllPages<MetaInsightsRow>(
      'INSIGHTS',
      url.toString(),
      `insights ${apiLevel} da conta ${adAccount.externalAccountId}`,
    );
  }

  async revokeToken(integration: Integration): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Skipping Meta revoke; provider not configured');
      return;
    }
    try {
      const url = new URL(
        `https://graph.facebook.com/${this.apiVersion}/me/permissions`,
      );
      url.searchParams.set('access_token', integration.accessToken);

      const response = await fetch(url, { method: 'DELETE' });
      if (!response.ok) {
        this.logger.warn(
          `Meta revoke returned non-200 status (${response.status}); marking integration disconnected anyway`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Meta revoke threw (${(error as Error).message}); marking integration disconnected anyway`,
      );
    }
  }

  private async fetchCampaigns(
    adAccount: AdAccount,
    integration: Integration,
    options?: SyncOptions,
  ): Promise<MetaPage<ProviderSyncResult['campaigns'][number]>> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/campaigns`,
    );
    url.searchParams.set(
      'fields',
      'id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time',
    );
    url.searchParams.set('limit', '200');
    applyUpdatedSince(url, 'campaign', options?.updatedSince);
    url.searchParams.set('access_token', integration.accessToken);

    const page = await this.fetchAllPages<MetaCampaignNode>(
      'CAMPAIGNS',
      url.toString(),
      `campanhas da conta ${adAccount.externalAccountId}`,
    );

    return {
      ...page,
      items: page.items.map((node) => ({
        externalCampaignId: node.id,
        name: node.name,
        status: node.status ?? null,
        objective: node.objective ?? null,
        optimization: resolveMetaCampaignOptimization(node.objective).target,
        // `/100` fixo errava toda conta cuja moeda não tem duas casas — ¥50.000
        // viravam ¥500 na tela, e A2-S7 escreveria de volta o número lido.
        dailyBudget: fromMinorUnits(node.daily_budget, adAccount.currency),
        lifetimeBudget: fromMinorUnits(
          node.lifetime_budget,
          adAccount.currency,
        ),
        currency: adAccount.currency,
        startedAt: node.start_time ? new Date(node.start_time) : null,
        endedAt: node.stop_time ? new Date(node.stop_time) : null,
        metadata: null,
      })),
    };
  }

  private mapInsightRow(
    row: MetaInsightsRow,
    level: MetricLevel,
    spec: MetaConversionSpec | null,
  ): ProviderMetricRow {
    // O evento do conjunto decide o que é conversão nesta linha — ver
    // `meta-conversion-events.ts`. Receita e custo vêm do mesmo tipo contado.
    const counted = countMetaConversions(row, spec);

    const spend = numberOr(row.spend, 0);
    const impressions = numberOr(row.impressions, 0);
    const clicks = numberOr(row.clicks, 0);
    const conversions = counted.conversions;
    const revenue = counted.revenue;
    const ctr = row.ctr !== undefined ? numberOr(row.ctr, null) : null;
    const cpc = row.cpc !== undefined ? numberOr(row.cpc, null) : null;
    const cpa = counted.cpa ?? (conversions > 0 ? spend / conversions : null);
    const roas = revenue > 0 && spend > 0 ? revenue / spend : null;
    const frequency =
      row.frequency !== undefined ? numberOr(row.frequency, null) : null;
    const reach = row.reach !== undefined ? numberOr(row.reach, null) : null;

    const videoThru = (row.video_thruplay_watched_actions ?? []).find(
      (a) => a.action_type === 'video_view',
    );
    const videoP25 = (row.video_p25_watched_actions ?? []).find(
      (a) => a.action_type === 'video_view',
    );
    const videoP100 = (row.video_p100_watched_actions ?? []).find(
      (a) => a.action_type === 'video_view',
    );
    const videoPlay = (row.video_play_actions ?? []).find(
      (a) => a.action_type === 'video_view',
    );
    const videoViews = videoThru ? numberOr(videoThru.value, null) : null;
    const thumbstopRate =
      videoPlay && impressions > 0
        ? numberOr(videoPlay.value, 0) / impressions
        : null;
    const holdRate =
      videoP25 && videoP100
        ? numberOr(videoP100.value, 0) /
          Math.max(numberOr(videoP25.value, 1), 1)
        : null;
    const engagement = row.inline_link_clicks
      ? numberOr(row.inline_link_clicks, null)
      : null;

    // Feedback negativo (§12.2). O Graph entrega estes sinais dentro de
    // `actions`, com um `action_type` por tipo de reação negativa — e só quando
    // a conta os expõe: contas sem volume suficiente para anonimizar a métrica
    // simplesmente não trazem a entrada.
    //
    // **Ausente vira `null`, nunca `0`.** Zero afirma "ninguém escondeu este
    // anúncio"; `null` afirma "a plataforma não nos disse". A distinção decide
    // se `NegativeFeedbackRisk` entra no composto ou se declara indisponível, e
    // trocá-las faria o produto reportar risco baixo por ignorância.
    const negative = (type: string): number | null => {
      const action = (row.actions ?? []).find((a) => a.action_type === type);
      return action ? numberOr(action.value, null) : null;
    };

    const hides = negative('post_hide');
    const hideAllFor = negative('post_hide_all');
    const reports = negative('post_report_spam');
    const unlikes = negative('unlike_page');

    const campaignExternalId = row.campaign_id ?? '__account__';
    const adSetExternalId = row.adset_id ?? null;
    const adExternalId = row.ad_id ?? null;

    let externalEntityId: string;
    switch (level) {
      case 'CAMPAIGN':
        externalEntityId = campaignExternalId;
        break;
      case 'ADSET':
        externalEntityId = adSetExternalId ?? campaignExternalId;
        break;
      case 'AD':
        externalEntityId =
          adExternalId ?? adSetExternalId ?? campaignExternalId;
        break;
      default:
        externalEntityId = campaignExternalId;
    }

    return {
      date: new Date(row.date_start),
      level,
      externalEntityId,
      campaignExternalId,
      adSetExternalId,
      adExternalId,
      creativeExternalId: null,
      spend,
      impressions,
      clicks,
      conversions,
      revenue,
      ctr,
      cpc,
      cpa,
      roas,
      frequency,
      reach,
      videoViews,
      engagement,
      thumbstopRate,
      holdRate,
      hides,
      hideAllFor,
      reports,
      unlikes,
    };
  }

  private async fetchAdSets(
    adAccount: AdAccount,
    integration: Integration,
    options?: SyncOptions,
  ): Promise<MetaPage<MetaAdSetRead>> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/adsets`,
    );
    url.searchParams.set(
      'fields',
      'id,name,status,campaign_id,optimization_goal,promoted_object,billing_event,daily_budget,lifetime_budget,targeting,start_time,end_time',
    );
    url.searchParams.set('limit', '500');
    applyUpdatedSince(url, 'adset', options?.updatedSince);
    url.searchParams.set('access_token', integration.accessToken);

    const page = await this.fetchAllPages<MetaAdSetNode>(
      'AD_SETS',
      url.toString(),
      `conjuntos da conta ${adAccount.externalAccountId}`,
    );

    return {
      ...page,
      items: page.items.map((n) => {
        const conversionSpec = resolveMetaAdSetOptimization({
          optimizationGoal: n.optimization_goal,
          promotedObject: n.promoted_object,
        });

        return {
          externalAdSetId: n.id,
          campaignExternalId: n.campaign_id,
          name: n.name,
          status: n.status ?? null,
          optimizationGoal: n.optimization_goal ?? null,
          // `UNKNOWN` explícito, e não ausente: a meta foi lida e não diz nada, e
          // o anúncio resolve pelo objetivo da campanha.
          optimization: conversionSpec?.target ?? UNKNOWN_OPTIMIZATION,
          conversionSpec,
          billingEvent: n.billing_event ?? null,
          dailyBudget: fromMinorUnits(n.daily_budget, adAccount.currency),
          lifetimeBudget: fromMinorUnits(n.lifetime_budget, adAccount.currency),
          targeting: n.targeting ?? null,
          startedAt: n.start_time ? new Date(n.start_time) : null,
          endedAt: n.end_time ? new Date(n.end_time) : null,
        };
      }),
    };
  }

  /**
   * Só o evento de conversão dos conjuntos pedidos — para o refresh dirigido.
   *
   * **Leitura acessória, não estrutural:** a falha não entra em
   * `stepFailures`, porque não diz nada sobre o que arquivar. Sem ela, a linha
   * cai para o objetivo da campanha e, na falta dele, para a compra incidental
   * — que nenhum detector de conversão julga, porque o portão de objetivo lê o
   * que está gravado no conjunto.
   */
  private async fetchAdSetSpecs(
    adAccount: AdAccount,
    integration: Integration,
    adSetIds: string[],
  ): Promise<
    Array<{
      externalAdSetId: string;
      conversionSpec: MetaConversionSpec | null;
    }>
  > {
    if (adSetIds.length === 0) return [];

    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/adsets`,
    );
    url.searchParams.set('fields', 'id,optimization_goal,promoted_object');
    url.searchParams.set(
      'filtering',
      JSON.stringify([{ field: 'adset.id', operator: 'IN', value: adSetIds }]),
    );
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', integration.accessToken);

    const page = await this.fetchAllPages<MetaAdSetNode>(
      'AD_SETS',
      url.toString(),
      `evento de conversão dos conjuntos da conta ${adAccount.externalAccountId}`,
    );

    return page.items.map((node) => ({
      externalAdSetId: node.id,
      conversionSpec: resolveMetaAdSetOptimization({
        optimizationGoal: node.optimization_goal,
        promotedObject: node.promoted_object,
      }),
    }));
  }

  private async fetchAds(
    adAccount: AdAccount,
    integration: Integration,
    options?: SyncOptions,
  ): Promise<MetaPage<ProviderAd>> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/ads`,
    );
    // `effective_status` é o que a plataforma realmente veicula (herda pausa do
    // conjunto e da campanha); `status` sozinho diz `ACTIVE` para anúncio que não
    // roda há semanas — e a reconciliação leria isso como drift nosso.
    url.searchParams.set(
      'fields',
      'id,name,status,effective_status,updated_time,adset_id,campaign_id,creative{id}',
    );
    url.searchParams.set('limit', '500');
    applyUpdatedSince(url, 'ad', options?.updatedSince);
    if (options?.adExternalIds?.length) {
      url.searchParams.set(
        'filtering',
        JSON.stringify([
          { field: 'ad.id', operator: 'IN', value: options.adExternalIds },
        ]),
      );
    }
    url.searchParams.set('access_token', integration.accessToken);

    const page = await this.fetchAllPages<MetaAdNode>(
      'ADS',
      url.toString(),
      `anúncios da conta ${adAccount.externalAccountId}`,
    );

    return {
      ...page,
      items: page.items.map((n) => ({
        externalAdId: n.id,
        adSetExternalId: n.adset_id,
        campaignExternalId: n.campaign_id,
        creativeExternalId: n.creative?.id ?? null,
        name: n.name,
        status: n.effective_status ?? n.status ?? null,
        updatedAt: n.updated_time ? new Date(n.updated_time) : null,
      })),
    };
  }

  private async fetchCreatives(
    adAccount: AdAccount,
    integration: Integration,
  ): Promise<MetaPage<ProviderCreative>> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${adAccount.externalAccountId}/adcreatives`,
    );
    url.searchParams.set(
      'fields',
      'id,name,title,body,call_to_action_type,object_type,thumbnail_url,video_id,image_url,object_story_spec',
    );
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', integration.accessToken);

    const page = await this.fetchAllPages<MetaCreativeNode>(
      'CREATIVES',
      url.toString(),
      `criativos da conta ${adAccount.externalAccountId}`,
    );

    return {
      ...page,
      items: page.items.map((n) => ({
        externalCreativeId: n.id,
        name: n.name ?? null,
        title: n.title ?? null,
        body: n.body ?? null,
        callToAction: n.call_to_action_type ?? null,
        format: n.object_type ?? null,
        thumbnailUrl: n.thumbnail_url ?? null,
        videoUrl: n.video_id ?? null,
        imageUrl: n.image_url ?? null,
        landingPageUrl:
          n.object_story_spec?.link_data?.link ??
          n.object_story_spec?.video_data?.call_to_action?.value?.link ??
          null,
      })),
    };
  }

  private mapAccountStatus(status?: number): string {
    switch (status) {
      case 1:
        return 'ACTIVE';
      case 2:
        return 'DISABLED';
      case 3:
        return 'UNSETTLED';
      case 7:
        return 'PENDING_RISK_REVIEW';
      case 9:
        return 'IN_GRACE_PERIOD';
      case 100:
        return 'PENDING_CLOSURE';
      case 101:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  }

  private async validateState(state: string): Promise<AuthorizationSubject> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verify(state);
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_META_STATE',
        message: 'Meta OAuth state is invalid or expired',
      });
    }

    const accountId = payload.sub;
    const provider = payload.provider;
    const purpose = payload.purpose;
    const issuedAt = payload.iat;
    const organizationId = payload.organizationId;
    const now = Math.floor(Date.now() / 1000);

    if (
      typeof accountId !== 'string' ||
      provider !== 'META' ||
      purpose !== 'connect-integration' ||
      typeof issuedAt !== 'number'
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_META_STATE',
        message: 'Meta OAuth state is invalid or expired',
      });
    }

    if (now - issuedAt > META_STATE_TTL_SECONDS) {
      throw new UnauthorizedException({
        code: 'EXPIRED_META_STATE',
        message: 'Meta OAuth state has expired',
      });
    }

    return {
      accountId,
      // `state` emitido antes desta mudança não carrega organização: o callback
      // cai no caminho antigo em vez de recusar quem já estava no meio do fluxo.
      organizationId:
        typeof organizationId === 'string' ? organizationId : null,
    };
  }

  private async exchangeAuthorizationCode(
    authorizationCode: string,
  ): Promise<MetaTokenResponse> {
    const config = this.requireConfig();
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/oauth/access_token`,
    );
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('client_secret', config.appSecret);
    url.searchParams.set('code', authorizationCode);

    return this.fetchToken(url);
  }

  private async exchangeForLongLivedToken(
    shortLivedToken: string,
  ): Promise<MetaTokenResponse> {
    const config = this.requireConfig();
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/oauth/access_token`,
    );
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('client_secret', config.appSecret);
    url.searchParams.set('fb_exchange_token', shortLivedToken);

    return this.fetchToken(url);
  }

  private async fetchToken(url: URL): Promise<MetaTokenResponse> {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const body = (await response.json()) as MetaTokenResponse &
      MetaErrorResponse;

    if (
      !response.ok ||
      !body.access_token ||
      typeof body.expires_in !== 'number'
    ) {
      throw new BadGatewayException({
        code: 'META_TOKEN_EXCHANGE_FAILED',
        message:
          body.error?.message ??
          'Unable to exchange authorization code with Meta',
      });
    }

    return body;
  }

  private throwGraphError(
    code: string,
    body: MetaErrorResponse,
    status: number,
  ): never {
    throw new BadGatewayException({
      code,
      message: body.error?.message ?? `Meta Graph API error (status ${status})`,
    });
  }
}

function numberOr<T extends number | null>(
  value: string | undefined,
  fallback: T,
): T extends null ? number | null : number {
  if (value === undefined || value === null || value === '') {
    return fallback as never;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return fallback as never;
  }
  return parsed as never;
}

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
