import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import { googleDeliveryStatus } from 'src/modules/ads/domain/platform/delivery-status';
import {
  googleAssetGroupExternalId,
  splitGoogleUnitIds,
} from 'src/modules/ads/domain/platform/google-unit-id';
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
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import { classifyGoogleCampaign } from './google-optimization';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * A versão sai de configuração pelo mesmo motivo da Meta: ela expira no
 * calendário do Google, não no nosso. `v17` é de meados de 2024 e já estava
 * aposentada quando A2-S8 foi escrever contra ela.
 */
const GOOGLE_OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH_REVOKE = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL_SECONDS = 60 * 10;
const DEFAULT_SCOPES = 'https://www.googleapis.com/auth/adwords';

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

/** Credentials proven present by `readConfig`. Every field is a real `string`. */
type GoogleAdsConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  developerToken: string;
  scopes: string;
  loginCustomerId?: string;
};

/**
 * As linhas GAQL no formato JSON da REST: campos em lowerCamelCase, `int64`
 * como string. Tipadas campo a campo — um `Record<string, any>` aqui deixava
 * `campaign_budget.amount_micros` e `amountMicros` igualmente "válidos", e o
 * erro de nome só aparecia como `null` na tela.
 */
type GoogleCampaignNode = {
  id?: string;
  name?: string;
  status?: string;
  advertisingChannelType?: string;
  /** O que a campanha busca — é daqui que sai a classe de otimização. */
  biddingStrategyType?: string;
};

type GoogleConversionGoalNode = {
  category?: string;
  biddable?: boolean;
};

type GoogleBudgetNode = {
  resourceName?: string;
  amountMicros?: string;
  totalAmountMicros?: string;
  period?: string;
  explicitlyShared?: boolean;
};

type GoogleAdGroupNode = {
  id?: string;
  name?: string;
  status?: string;
  type?: string;
};

/** `pinnedField` fixa o asset numa posição; perdê-lo numa escrita despinaria. */
type GoogleTextAsset = { text?: string; pinnedField?: string };

/** Título, descrição e chamada de um anúncio que não é de busca. */
type GoogleDisplayAdNode = {
  headlines?: GoogleTextAsset[];
  descriptions?: GoogleTextAsset[];
  callToActionText?: string;
};

/**
 * `VideoResponsiveAdInfo` — o formato de vídeo unificado que substituiu o
 * TrueView Discovery Ad. Estruturalmente igual a `responsiveDisplayAd`: listas
 * de asset de texto, não string única — só `callToActions` foge do padrão de
 * `callToActionText` porque a plataforma trata a chamada como asset rotativo
 * aqui, não como campo fixo.
 *
 * Os formatos de vídeo que **não** são cobertos (`in_stream`, `bumper`,
 * `non_skippable`, `out_stream`) não têm título no mesmo sentido: são overlay
 * de poucas palavras sobre o vídeo, não um campo que `MISSING_HEADLINE` possa
 * cobrar. Estendê-los é trabalho futuro, não uma omissão silenciosa — eles
 * continuam com `title`/`body`/`callToAction` nulos, do jeito que já estavam.
 */
type GoogleVideoResponsiveAdNode = {
  headlines?: GoogleTextAsset[];
  descriptions?: GoogleTextAsset[];
  callToActions?: GoogleTextAsset[];
};

type GoogleAdNode = {
  id?: string;
  name?: string;
  type?: string;
  finalUrls?: string[];
  responsiveSearchAd?: {
    headlines?: GoogleTextAsset[];
    descriptions?: GoogleTextAsset[];
  };
  responsiveDisplayAd?: GoogleDisplayAdNode;
  demandGenMultiAssetAd?: GoogleDisplayAdNode;
  demandGenCarouselAd?: { callToActionText?: string };
  videoResponsiveAd?: GoogleVideoResponsiveAdNode;
  imageAd?: { imageUrl?: string };
};

type GoogleAdGroupAdNode = {
  status?: string;
  ad?: GoogleAdNode;
  policySummary?: { approvalStatus?: string; reviewStatus?: string };
};

type GoogleMetricsNode = {
  costMicros?: string;
  impressions?: string;
  clicks?: string;
  conversions?: number | string;
  conversionsValue?: number | string;
  ctr?: number | string;
  averageCpc?: number | string;
  videoTrueviewViews?: string;
  engagements?: string;
  videoQuartileP25Rate?: number | string;
  videoQuartileP100Rate?: number | string;
};

/** O grupo de recursos do Performance Max — a unidade quando não há anúncio. */
type GoogleAssetGroupNode = {
  id?: string;
  name?: string;
  status?: string;
  finalUrls?: string[];
  adStrength?: string;
};

type GoogleAssetGroupAssetNode = {
  fieldType?: string;
  status?: string;
  /** A classificação do Google para o recurso: `BEST`, `GOOD`, `LOW`, `LEARNING`... */
  performanceLabel?: string;
};

type GoogleAssetNode = {
  id?: string;
  type?: string;
  textAsset?: { text?: string };
  imageAsset?: { fullSize?: { url?: string } };
  youtubeVideoAsset?: { youtubeVideoId?: string };
  callToActionAsset?: { callToAction?: string };
};

type GAQLRow = {
  campaign?: GoogleCampaignNode;
  campaignConversionGoal?: GoogleConversionGoalNode;
  adGroup?: GoogleAdGroupNode;
  adGroupAd?: GoogleAdGroupAdNode;
  assetGroup?: GoogleAssetGroupNode;
  assetGroupAsset?: GoogleAssetGroupAssetNode;
  asset?: GoogleAssetNode;
  campaignBudget?: GoogleBudgetNode;
  metrics?: GoogleMetricsNode;
  segments?: { date?: string };
};

/**
 * Consulta recusada pela API — com o status HTTP, para quem chama distinguir um
 * campo que a versão não aceita (400) de uma indisponibilidade.
 */
class GoogleQueryError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google Ads API error (${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'GoogleQueryError';
  }
}

/**
 * **Estrutura sem `segments.date`.** Com o segmento de data, a API só devolve
 * linhas com métrica no período — uma campanha, um grupo ou um anúncio pausado
 * a semana inteira simplesmente não vem. Como a varredura é completa em toda
 * leitura do Google (`supportsUpdatedSince: false`), o que não veio seria
 * **arquivado** pela guarda de §8.2: todo anúncio parado sumiria da Allva.
 *
 * `REMOVED` fica de fora em todos os níveis, pelo mesmo motivo que a Meta não
 * lista o que foi apagado: o que a plataforma removeu deve ser arquivado aqui.
 */
const CAMPAIGN_STRUCTURE_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    campaign.bidding_strategy_type,
    campaign_budget.resource_name,
    campaign_budget.amount_micros,
    campaign_budget.total_amount_micros,
    campaign_budget.period,
    campaign_budget.explicitly_shared
  FROM campaign
  WHERE campaign.status != 'REMOVED'
`;

/**
 * As metas de conversão **lançáveis** de cada campanha — as que entram em
 * `metrics.conversions`. É o que diz qual evento a campanha otimiza (compra,
 * lead, cadastro...) e se ela tem meta para otimizar.
 */
const CAMPAIGN_CONVERSION_GOALS_QUERY = `
  SELECT
    campaign.id,
    campaign_conversion_goal.category,
    campaign_conversion_goal.biddable
  FROM campaign_conversion_goal
  WHERE campaign_conversion_goal.biddable = TRUE
`;

const AD_GROUP_STRUCTURE_QUERY = `
  SELECT
    campaign.id,
    ad_group.id,
    ad_group.name,
    ad_group.status,
    ad_group.type
  FROM ad_group
  WHERE ad_group.status != 'REMOVED'
    AND campaign.status != 'REMOVED'
`;

const BASE_AD_STRUCTURE_FIELDS = [
  'campaign.id',
  'campaign.status',
  'ad_group.id',
  'ad_group.status',
  'ad_group_ad.ad.id',
  'ad_group_ad.ad.name',
  'ad_group_ad.ad.type',
  'ad_group_ad.status',
  'ad_group_ad.policy_summary.approval_status',
  'ad_group_ad.policy_summary.review_status',
  'ad_group_ad.ad.final_urls',
  'ad_group_ad.ad.responsive_search_ad.headlines',
  'ad_group_ad.ad.responsive_search_ad.descriptions',
  'ad_group_ad.ad.image_ad.image_url',
];

/**
 * O texto dos anúncios que não são de busca — é daqui que sai a chamada para
 * ação que `REPLACE_CTA` escreve.
 *
 * Separados dos campos-base porque a recusa de um campo derruba a consulta
 * inteira: se a versão da API não aceitar algum deles, a leitura de estrutura
 * relê sem eles em vez de deixar a conta sem anúncio nenhum.
 */
const DISPLAY_AD_STRUCTURE_FIELDS = [
  'ad_group_ad.ad.responsive_display_ad.headlines',
  'ad_group_ad.ad.responsive_display_ad.descriptions',
  'ad_group_ad.ad.responsive_display_ad.call_to_action_text',
  'ad_group_ad.ad.demand_gen_multi_asset_ad.headlines',
  'ad_group_ad.ad.demand_gen_multi_asset_ad.descriptions',
  'ad_group_ad.ad.demand_gen_multi_asset_ad.call_to_action_text',
  'ad_group_ad.ad.demand_gen_carousel_ad.call_to_action_text',
  // O anúncio de vídeo unificado (ex-TrueView Discovery). Sem isto, `toCreative`
  // não tinha de onde tirar título, corpo ou CTA de um anúncio de vídeo — e
  // `MISSING_HEADLINE`/`MISSING_CTA` disparavam em cima de um campo que a
  // plataforma nunca leu, não de um campo que a pessoa deixou vazio.
  'ad_group_ad.ad.video_responsive_ad.headlines',
  'ad_group_ad.ad.video_responsive_ad.descriptions',
  'ad_group_ad.ad.video_responsive_ad.call_to_actions',
];

function adStructureQuery(input: {
  adIdFilter: string;
  extended: boolean;
}): string {
  const fields = input.extended
    ? [...BASE_AD_STRUCTURE_FIELDS, ...DISPLAY_AD_STRUCTURE_FIELDS]
    : BASE_AD_STRUCTURE_FIELDS;

  return `
    SELECT
      ${fields.join(',\n      ')}
    FROM ad_group_ad
    WHERE ad_group_ad.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
      AND campaign.status != 'REMOVED'${input.adIdFilter}
  `;
}

const BASE_METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.conversions',
  'metrics.conversions_value',
  'metrics.ctr',
  'metrics.average_cpc',
];

/**
 * Vídeo e engajamento, que o `PlatformProfile` declara disponíveis no Google.
 *
 * `metrics.video_views` foi renomeado para `video_trueview_views` na v22 — é por
 * isso que o provider devolvia `null` para os dois campos enquanto o perfil os
 * prometia. Ficam numa lista separada porque nem todo tipo de campanha aceita
 * selecioná-los: uma recusa aqui não pode custar a série inteira (ver
 * `readAdMetrics`).
 *
 * `video_quartile_p25_rate`/`video_quartile_p100_rate` são o equivalente do
 * Google a `thumbstopRate`/`holdRate` (Meta/TikTok): fração dos impressions que
 * passou do primeiro quarto do vídeo, e fração de quem passou do primeiro
 * quarto que foi até o fim. Sem eles, `attention` era **estruturalmente**
 * incalculável no Google — não por falta de dado, mas porque nenhum dos dois
 * campos que a calculadora lê jamais chegava do provider.
 */
const EXTENDED_AD_METRIC_FIELDS = [
  'metrics.video_trueview_views',
  'metrics.engagements',
  'metrics.video_quartile_p25_rate',
  'metrics.video_quartile_p100_rate',
];

function adMetricsQuery(input: {
  since: string;
  until: string;
  adIdFilter: string;
  extended: boolean;
}): string {
  const fields = input.extended
    ? [...BASE_METRIC_FIELDS, ...EXTENDED_AD_METRIC_FIELDS]
    : BASE_METRIC_FIELDS;

  return `
    SELECT
      campaign.id,
      ad_group.id,
      ad_group_ad.ad.id,
      ${fields.join(',\n      ')},
      segments.date
    FROM ad_group_ad
    WHERE segments.date BETWEEN '${input.since}' AND '${input.until}'${input.adIdFilter}
  `;
}

function entityMetricsQuery(
  resource: 'campaign' | 'ad_group',
  since: string,
  until: string,
): string {
  const ids =
    resource === 'campaign' ? 'campaign.id' : 'campaign.id, ad_group.id';

  return `
    SELECT
      ${ids},
      ${BASE_METRIC_FIELDS.join(',\n      ')},
      segments.date
    FROM ${resource}
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `;
}

/**
 * O filtro do refresh dirigido. Os ids chegam separados e validados por
 * `splitGoogleUnitIds` — só numéricos, porque o que vem de fora é interpolado
 * em GAQL.
 */
function idInClause(field: string, ids: string[]): string {
  return ids.length > 0 ? `\n      AND ${field} IN (${ids.join(', ')})` : '';
}

/**
 * **Performance Max não tem anúncio** — só grupos de recursos (D23).
 *
 * `FROM ad_group_ad` não devolve nada de uma campanha PMax, e ela entrava na
 * Allva sem unidade nenhuma: gasto fora do score, da detecção e dos totais. O
 * grupo de recursos é a menor entidade com status, série e pausa próprios, e é
 * ele que vira a unidade analisada.
 *
 * Sem `segments.date` pelo mesmo motivo da estrutura dos anúncios: grupo
 * pausado a semana inteira sumiria da leitura e seria arquivado.
 */
function assetGroupStructureQuery(assetGroupIdFilter: string): string {
  return `
    SELECT
      campaign.id,
      campaign.status,
      asset_group.id,
      asset_group.name,
      asset_group.status,
      asset_group.final_urls,
      asset_group.ad_strength
    FROM asset_group
    WHERE asset_group.status != 'REMOVED'
      AND campaign.status != 'REMOVED'${assetGroupIdFilter}
  `;
}

/**
 * Os recursos de cada grupo — títulos, descrições, imagens, vídeos e a
 * chamada para ação. É o "criativo" do grupo: um pacote, não uma peça.
 *
 * Imagem, vídeo e chamada ficam na versão estendida pela mesma razão do texto
 * de display: a recusa de um campo derruba a consulta, e perder a imagem é
 * melhor que perder os títulos.
 */
function assetGroupAssetsQuery(input: {
  assetGroupIdFilter: string;
  extended: boolean;
}): string {
  const fields = [
    'asset_group.id',
    'asset_group_asset.field_type',
    'asset_group_asset.status',
    'asset.id',
    'asset.type',
    'asset.text_asset.text',
    ...(input.extended
      ? [
          'asset.image_asset.full_size.url',
          'asset.youtube_video_asset.youtube_video_id',
          'asset.call_to_action_asset.call_to_action',
        ]
      : []),
  ];

  return `
    SELECT
      ${fields.join(',\n      ')}
    FROM asset_group_asset
    WHERE asset_group_asset.status != 'REMOVED'
      AND asset_group.status != 'REMOVED'${input.assetGroupIdFilter}
  `;
}

/**
 * A classificação que o Google dá a cada recurso do grupo (Melhor, Bom, Baixo,
 * Aprendendo). É o sinal criativo que o Performance Max expõe no lugar da
 * série por peça, que ele não entrega.
 *
 * Leitura **acessória**, em consulta separada: o campo já mudou de semântica
 * entre versões da API, e a recusa dele não pode custar os títulos nem a
 * imagem do grupo.
 */
function assetPerformanceLabelsQuery(assetGroupIdFilter: string): string {
  return `
    SELECT
      asset_group.id,
      asset.id,
      asset_group_asset.field_type,
      asset_group_asset.performance_label
    FROM asset_group_asset
    WHERE asset_group_asset.status != 'REMOVED'
      AND asset_group.status != 'REMOVED'${assetGroupIdFilter}
  `;
}

/**
 * Métricas **mínimas** do grupo: o que sobra quando a versão da API recusa CTR
 * e CPC médio neste recurso. Os dois são derivados de cliques, impressões e
 * custo — perder a leitura inteira por eles deixaria o PMax sem gasto de novo.
 */
const MINIMAL_METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.conversions',
  'metrics.conversions_value',
];

function assetGroupMetricsQuery(input: {
  since: string;
  until: string;
  assetGroupIdFilter: string;
  extended: boolean;
}): string {
  const fields = input.extended ? BASE_METRIC_FIELDS : MINIMAL_METRIC_FIELDS;

  return `
    SELECT
      campaign.id,
      asset_group.id,
      ${fields.join(',\n      ')},
      segments.date
    FROM asset_group
    WHERE segments.date BETWEEN '${input.since}' AND '${input.until}'${input.assetGroupIdFilter}
  `;
}

/** O canal que só tem grupo de recursos — e o único que paga as leituras dele. */
const PERFORMANCE_MAX = 'PERFORMANCE_MAX';

type AssetGroupRead = {
  structure: GAQLRow[];
  /** `null` quando a leitura dos recursos falhou: o criativo não é reescrito. */
  assets: GAQLRow[] | null;
  /** `null` quando a classificação não pôde ser lida — ela some, nada mais. */
  labels: Map<string, string> | null;
  metrics: GAQLRow[];
};

const NO_ASSET_GROUPS: AssetGroupRead = {
  structure: [],
  assets: [],
  labels: null,
  metrics: [],
};

/** A chave de um recurso **no grupo**: o mesmo recurso pode estar em vários. */
function assetKey(row: GAQLRow): string | null {
  const assetGroupId = row.assetGroup?.id;
  const assetId = row.asset?.id;
  const fieldType = row.assetGroupAsset?.fieldType;
  return assetGroupId && assetId && fieldType
    ? `${assetGroupId}:${assetId}:${fieldType}`
    : null;
}

@Injectable()
export class GoogleAdsProvider implements AdsProviderGateway {
  readonly platform: Platform = 'GOOGLE';
  private readonly logger = new Logger(GoogleAdsProvider.name);

  /** A versão da Google Ads API — configuração, não constante (ver acima). */
  private get adsBase(): string {
    return `https://googleads.googleapis.com/${this.envService.get('GOOGLE_ADS_API_VERSION')}`;
  }

  constructor(
    private readonly envService: EnvService,
    private readonly jwtService: JwtServiceInterface,
  ) {}

  /**
   * Every credential this provider needs, already proven present (PLAN.md D-5).
   *
   * `ensureConfigured()` used to guarantee this by convention — "call me first" —
   * which the type system could not see, so each read still looked like
   * `string | undefined` at its use site. Returning a validated bundle makes the
   * guarantee flow through the types instead: there is no way to reach a
   * credential without having gone through the check.
   */
  private readonly requiredKeys = [
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REDIRECT_URI',
    'GOOGLE_ADS_DEVELOPER_TOKEN',
  ] as const;

  isConfigured(): boolean {
    return this.readConfig() !== null;
  }

  /** `null` when any required credential is missing or blank. */
  private readConfig(): GoogleAdsConfig | null {
    const values = this.requiredKeys.map((key) =>
      this.envService.get(key)?.trim(),
    );

    if (values.some((value) => !value)) return null;

    const [clientId, clientSecret, redirectUri, developerToken] = values as [
      string,
      string,
      string,
      string,
    ];

    return {
      clientId,
      clientSecret,
      redirectUri,
      developerToken,
      scopes:
        this.envService.get('GOOGLE_ADS_SCOPES')?.trim() || DEFAULT_SCOPES,
      loginCustomerId:
        this.envService.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID')?.trim() ||
        undefined,
    };
  }

  private requireConfig(): GoogleAdsConfig {
    const config = this.readConfig();

    if (!config) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'Google Ads provider is not configured',
      });
    }

    return config;
  }

  async getAuthorizationUrl(context: AuthorizationContext): Promise<string> {
    const config = this.requireConfig();

    const state = await this.jwtService.sign({
      sub: context.accountId,
      provider: 'GOOGLE',
      purpose: 'connect-integration',
      nonce: randomBytes(16).toString('hex'),
      organizationId: context.organizationId,
    });

    const url = new URL(GOOGLE_OAUTH_AUTHORIZE);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', state);
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

    const params = new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(GOOGLE_OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BadGatewayException({
        code: 'GOOGLE_TOKEN_EXCHANGE_FAILED',
        message: `Google token exchange failed (${response.status})`,
        detail: text,
      });
    }

    const body = (await response.json()) as TokenResponse;
    if (!body.access_token) {
      throw new BadGatewayException({
        code: 'GOOGLE_TOKEN_EXCHANGE_FAILED',
        message: 'Google did not return an access token',
      });
    }

    return {
      accountId,
      organizationId,
      token: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      },
    };
  }

  async refreshAccessToken(
    integration: Integration,
  ): Promise<ProviderTokenResult> {
    const config = this.requireConfig();

    if (!integration.refreshToken) {
      throw new UnauthorizedException({
        code: 'GOOGLE_REFRESH_TOKEN_MISSING',
        message: 'Refresh token missing; user must reconnect Google Ads',
      });
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(GOOGLE_OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BadGatewayException({
        code: 'GOOGLE_TOKEN_REFRESH_FAILED',
        message: `Google refresh failed (${response.status})`,
        detail: text,
      });
    }

    const body = (await response.json()) as TokenResponse;
    return {
      accessToken: body.access_token,
      refreshToken: integration.refreshToken,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
    };
  }

  async listAdAccounts(integration: Integration): Promise<ExternalAdAccount[]> {
    const config = this.requireConfig();

    const listUrl = `${this.adsBase}/customers:listAccessibleCustomers`;
    const headers = this.buildHeaders(integration, config);
    const response = await fetch(listUrl, { method: 'GET', headers });
    if (!response.ok) {
      await this.throwApiError(response, 'GOOGLE_LIST_ACCOUNTS_FAILED');
    }
    const body = (await response.json()) as { resourceNames?: string[] };
    const customerIds = (body.resourceNames ?? []).map((rn) =>
      rn.replace('customers/', ''),
    );

    const accounts: ExternalAdAccount[] = [];
    for (const customerId of customerIds) {
      try {
        const customer = await this.searchCustomer(
          integration,
          customerId,
          config,
        );

        /**
         * Conta gerente (MCC) não veicula anúncio: consulta de métrica sobre ela
         * é recusada pela API. Listá-la como vinculável produzia uma conta que
         * falha em todo ingest, para sempre — a Meta não tem esse caso porque
         * `/me/adaccounts` só devolve contas que anunciam.
         */
        if (customer.manager) {
          this.logger.log(
            `google.manager_account_skipped customer=${customerId} — conta gerente não veicula anúncios`,
          );
          continue;
        }

        accounts.push({
          externalAccountId: customerId,
          name: customer.descriptiveName ?? `Customer ${customerId}`,
          currency: customer.currencyCode ?? 'USD',
          timezone: customer.timeZone ?? 'UTC',
          status: 'ACTIVE',
          metadata: {
            manager: customer.manager,
            testAccount: customer.testAccount,
          },
        });
      } catch (err) {
        this.logger.warn(
          `Skipping Google customer ${customerId}: ${(err as Error).message}`,
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
    const config = this.requireConfig();
    const requestedLevels: MetricLevel[] = options?.levels ?? [
      'CAMPAIGN',
      'ADSET',
      'AD',
      'CREATIVE',
    ];

    const since = formatDate(dateRange.since);
    const until = formatDate(dateRange.until);

    /**
     * Cada consulta reporta a própria falha, como na Meta (A2-S3). Antes, uma
     * recusa qualquer levantava e derrubava o ingest inteiro — nenhum anúncio,
     * nenhuma métrica, e nenhuma etapa registrada dizendo o que falhou.
     */
    const failures: ProviderStepFailure[] = [];
    const read = async (
      step: ProviderFetchStep,
      query: string,
    ): Promise<GAQLRow[]> => {
      try {
        return await this.runGAQL(integration, adAccount, config, query);
      } catch (error) {
        failures.push(this.stepFailure(step, error));
        return [];
      }
    };

    /**
     * **Estrutura não é nível de métrica** — a mesma lição que custou a conta
     * inteira na Meta (ver `MetaAdsProvider.syncAdAccountMetrics`).
     *
     * O ingest pede `['AD', 'CREATIVE']`, e campanha e grupo estavam atrás de
     * `CAMPAIGN` e `ADSET`. Nenhuma campanha nem grupo chegava ao domínio, todo
     * anúncio ia para a quarentena com `CAMPAIGN_NOT_RESOLVED`, e o Google
     * sincronizava com saúde `HEALTHY` sem uma linha de série — nem teto diário.
     *
     * Campanha é lida sempre; grupo, fora do refresh dirigido, cujos anúncios já
     * têm o grupo resolvido no banco.
     */
    const readsAdStructure =
      requestedLevels.includes('AD') || requestedLevels.includes('CREATIVE');
    const targetedRefresh = Boolean(options?.adExternalIds?.length);
    // O refresh dirigido pode misturar anúncios e grupos de recursos: cada id
    // vai para o recurso que o lê, e um recurso sem id não é lido.
    const targetIds = splitGoogleUnitIds(options?.adExternalIds ?? []);
    const adIdFilter = targetedRefresh
      ? idInClause('ad_group_ad.ad.id', targetIds.adIds)
      : '';
    const assetGroupIdFilter = targetedRefresh
      ? idInClause('asset_group.id', targetIds.assetGroupIds)
      : '';
    const readsAds =
      readsAdStructure && (!targetedRefresh || adIdFilter !== '');
    const readsAssetGroups =
      readsAdStructure && (!targetedRefresh || assetGroupIdFilter !== '');
    const readsAdGroupStructure =
      requestedLevels.includes('ADSET') ||
      (readsAdStructure && !targetedRefresh);

    const [campaignRows, goalCategories, adGroupRows, adRows] =
      await Promise.all([
        read('CAMPAIGNS', CAMPAIGN_STRUCTURE_QUERY),
        this.readConversionGoals(integration, adAccount, config),
        readsAdGroupStructure
          ? read('AD_SETS', AD_GROUP_STRUCTURE_QUERY)
          : Promise.resolve<GAQLRow[]>([]),
        readsAds
          ? this.readAdStructure(
              { integration, adAccount, config, failures },
              adIdFilter,
            )
          : Promise.resolve<GAQLRow[]>([]),
      ]);

    /**
     * Só a conta com Performance Max paga as leituras de grupo de recursos. A
     * leitura dirigida a um grupo já prova que ele existe — e não depende de a
     * leitura de campanhas ter dado certo.
     */
    const hasPerformanceMax = campaignRows.some(
      (row) => row.campaign?.advertisingChannelType === PERFORMANCE_MAX,
    );
    const assetGroups =
      readsAssetGroups && (hasPerformanceMax || assetGroupIdFilter !== '')
        ? await this.readAssetGroups(
            { integration, adAccount, config, failures },
            {
              since,
              until,
              assetGroupIdFilter,
              withAssets: requestedLevels.includes('CREATIVE'),
            },
          )
        : NO_ASSET_GROUPS;

    const metrics: ProviderMetricRow[] = [];

    if (requestedLevels.includes('CAMPAIGN')) {
      const rows = await read(
        'INSIGHTS',
        entityMetricsQuery('campaign', since, until),
      );
      for (const row of dated(rows)) {
        const campaignId = String(row.campaign?.id);
        metrics.push(
          this.toMetric('CAMPAIGN', campaignId, row, {
            campaignExternalId: campaignId,
          }),
        );
      }
    }

    if (requestedLevels.includes('ADSET')) {
      const rows = await read(
        'INSIGHTS',
        entityMetricsQuery('ad_group', since, until),
      );
      for (const row of dated(rows)) {
        const adGroupId = String(row.adGroup?.id);
        metrics.push(
          this.toMetric('ADSET', adGroupId, row, {
            campaignExternalId: String(row.campaign?.id),
            adSetExternalId: adGroupId,
          }),
        );
      }
    }

    if (readsAds) {
      const rows = await this.readAdMetrics(
        { integration, adAccount, config, failures },
        { since, until, adIdFilter },
      );

      for (const row of dated(rows)) {
        const adId = String(row.adGroupAd?.ad?.id);
        const refs = {
          campaignExternalId: String(row.campaign?.id),
          adSetExternalId: String(row.adGroup?.id),
          adExternalId: adId,
          creativeExternalId: adId,
        };

        if (requestedLevels.includes('AD')) {
          metrics.push(this.toMetric('AD', adId, row, refs));
        }
        if (requestedLevels.includes('CREATIVE')) {
          metrics.push(this.toMetric('CREATIVE', adId, row, refs));
        }
      }
    }

    // O grupo de recursos entra na série como unidade: sem conjunto, com o
    // pacote de recursos no lugar do criativo.
    for (const row of dated(assetGroups.metrics)) {
      const unitId = googleAssetGroupExternalId(String(row.assetGroup?.id));
      const refs = {
        campaignExternalId: String(row.campaign?.id),
        adSetExternalId: null,
        adExternalId: unitId,
        creativeExternalId: unitId,
      };
      const withRates = { ...row, metrics: withDerivedRates(row.metrics) };

      if (requestedLevels.includes('AD')) {
        metrics.push(this.toMetric('AD', unitId, withRates, refs));
      }
      if (requestedLevels.includes('CREATIVE')) {
        metrics.push(this.toMetric('CREATIVE', unitId, withRates, refs));
      }
    }

    const campaigns = campaignRows.map((row) =>
      toCampaign(row, goalCategories),
    );
    // No Google a otimização é da campanha: o grupo herda, para o anúncio
    // resolver o mesmo objetivo pelo conjunto ou pela campanha.
    const optimizationByCampaign = new Map(
      campaigns.map((campaign) => [
        campaign.externalCampaignId,
        campaign.optimization ?? null,
      ]),
    );

    return {
      metrics,
      campaigns,
      adSets: adGroupRows.map((row) => toAdGroup(row, optimizationByCampaign)),
      ads: [...adRows.map(toAd), ...assetGroups.structure.map(toAssetGroupAd)],
      creatives: requestedLevels.includes('CREATIVE')
        ? [
            ...adRows.map(toCreative),
            // Sem a leitura dos recursos, o pacote não é reescrito: gravar
            // título e descrição nulos apagaria o que já estava lido.
            ...(assetGroups.assets
              ? toAssetGroupCreatives(
                  assetGroups.structure,
                  assetGroups.assets,
                  assetGroups.labels,
                )
              : []),
          ]
        : [],
      // Declarado, nunca inferido: só uma leitura sem nenhuma falha de etapa
      // autoriza o ingest a arquivar o que não veio (§8.2 passo 9).
      wasComplete: failures.length === 0,
      stepFailures: failures.length > 0 ? failures : undefined,
    };
  }

  async revokeToken(integration: Integration): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const token = integration.refreshToken ?? integration.accessToken;
      await fetch(`${GOOGLE_OAUTH_REVOKE}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
      });
    } catch (err) {
      this.logger.warn(
        `Google revoke threw (${(err as Error).message}); ignoring`,
      );
    }
  }

  // ---------------- helpers ----------------

  /**
   * A estrutura dos anúncios, com o texto do display e do Demand Gen quando a
   * versão da API os aceita.
   *
   * Mesma escada da série: recusa (400) relê só os campos-base. Perder a
   * chamada para ação de um anúncio de display custa a aplicabilidade do CTA
   * naquele anúncio; perder a consulta inteira mandaria toda a conta para a
   * quarentena por falta de anúncio.
   */
  private async readAdStructure(
    source: {
      integration: Integration;
      adAccount: AdAccount;
      config: GoogleAdsConfig;
      failures: ProviderStepFailure[];
    },
    adIdFilter: string,
  ): Promise<GAQLRow[]> {
    const { integration, adAccount, config, failures } = source;

    try {
      return await this.runGAQL(
        integration,
        adAccount,
        config,
        adStructureQuery({ adIdFilter, extended: true }),
      );
    } catch (error) {
      if (!(error instanceof GoogleQueryError) || error.status !== 400) {
        failures.push(this.stepFailure('ADS', error));
        return [];
      }

      this.logger.warn(
        `google.display_ad_fields_rejected customer=${adAccount.externalAccountId} — relendo a estrutura sem o texto de display`,
      );

      try {
        return await this.runGAQL(
          integration,
          adAccount,
          config,
          adStructureQuery({ adIdFilter, extended: false }),
        );
      } catch (retryError) {
        failures.push(this.stepFailure('ADS', retryError));
        return [];
      }
    }
  }

  /**
   * A série por anúncio, com vídeo e engajamento quando a conta permite.
   *
   * Se a consulta estendida for recusada (400), relê só as métricas-base: perder
   * vídeo e engajamento reduz a cobertura do score, que já declara o sinal
   * ausente; perder a série inteira deixaria a conta sem gasto nenhum.
   */
  private async readAdMetrics(
    source: {
      integration: Integration;
      adAccount: AdAccount;
      config: GoogleAdsConfig;
      failures: ProviderStepFailure[];
    },
    window: { since: string; until: string; adIdFilter: string },
  ): Promise<GAQLRow[]> {
    const { integration, adAccount, config, failures } = source;

    try {
      return await this.runGAQL(
        integration,
        adAccount,
        config,
        adMetricsQuery({ ...window, extended: true }),
      );
    } catch (error) {
      if (!(error instanceof GoogleQueryError) || error.status !== 400) {
        failures.push(this.stepFailure('INSIGHTS', error));
        return [];
      }

      this.logger.warn(
        `google.extended_metrics_rejected customer=${adAccount.externalAccountId} — relendo sem vídeo e engajamento`,
      );

      try {
        return await this.runGAQL(
          integration,
          adAccount,
          config,
          adMetricsQuery({ ...window, extended: false }),
        );
      } catch (retryError) {
        failures.push(this.stepFailure('INSIGHTS', retryError));
        return [];
      }
    }
  }

  /**
   * Estrutura, recursos e série dos grupos de recursos do Performance Max.
   *
   * A estrutura é etapa `ADS`: sem ela não se sabe que grupos existem, e a
   * leitura não pode autorizar arquivamento. Recursos e série seguem a escada
   * das consultas de anúncio — recusa (400) relê com menos campos antes de
   * desistir.
   */
  private async readAssetGroups(
    source: {
      integration: Integration;
      adAccount: AdAccount;
      config: GoogleAdsConfig;
      failures: ProviderStepFailure[];
    },
    input: {
      since: string;
      until: string;
      assetGroupIdFilter: string;
      withAssets: boolean;
    },
  ): Promise<AssetGroupRead> {
    const { integration, adAccount, config, failures } = source;
    const run = (query: string) =>
      this.runGAQL(integration, adAccount, config, query);

    const structure = run(
      assetGroupStructureQuery(input.assetGroupIdFilter),
    ).catch((error: unknown) => {
      failures.push(this.stepFailure('ADS', error));
      return [] as GAQLRow[];
    });

    const assets = input.withAssets
      ? this.withNarrowerRetry(
          (extended) =>
            run(
              assetGroupAssetsQuery({
                assetGroupIdFilter: input.assetGroupIdFilter,
                extended,
              }),
            ),
          {
            step: 'CREATIVES',
            adAccount,
            failures,
            label: 'asset_group_assets',
          },
        )
      : Promise.resolve<GAQLRow[] | null>([]);

    const metrics = this.withNarrowerRetry(
      (extended) =>
        run(
          assetGroupMetricsQuery({
            since: input.since,
            until: input.until,
            assetGroupIdFilter: input.assetGroupIdFilter,
            extended,
          }),
        ),
      { step: 'INSIGHTS', adAccount, failures, label: 'asset_group_metrics' },
    );

    const labels = input.withAssets
      ? this.readPerformanceLabels(
          { integration, adAccount, config },
          input.assetGroupIdFilter,
        )
      : Promise.resolve(null);

    const [structureRows, assetRows, labelMap, metricRows] = await Promise.all([
      structure,
      assets,
      labels,
      metrics,
    ]);

    return {
      structure: structureRows,
      assets: assetRows,
      labels: labelMap,
      metrics: metricRows ?? [],
    };
  }

  /**
   * A classificação de cada recurso, por `assetKey`. Falha não vai para
   * `stepFailures`: não diz nada sobre o que arquivar, e o criativo continua
   * inteiro sem ela.
   */
  private async readPerformanceLabels(
    source: {
      integration: Integration;
      adAccount: AdAccount;
      config: GoogleAdsConfig;
    },
    assetGroupIdFilter: string,
  ): Promise<Map<string, string> | null> {
    try {
      const rows = await this.runGAQL(
        source.integration,
        source.adAccount,
        source.config,
        assetPerformanceLabelsQuery(assetGroupIdFilter),
      );
      const labels = new Map<string, string>();
      for (const row of rows) {
        const key = assetKey(row);
        const label = row.assetGroupAsset?.performanceLabel;
        if (key && label) labels.set(key, label);
      }
      return labels;
    } catch (error) {
      this.logger.warn(
        `google.asset_performance_labels_unavailable customer=${source.adAccount.externalAccountId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * A escada de recusa: tenta a consulta completa e, num 400, a enxuta. Falha
   * que não é recusa de campo — ou a segunda tentativa falhando — vira falha de
   * etapa e devolve `null`.
   */
  private async withNarrowerRetry(
    query: (extended: boolean) => Promise<GAQLRow[]>,
    context: {
      step: ProviderFetchStep;
      adAccount: AdAccount;
      failures: ProviderStepFailure[];
      label: string;
    },
  ): Promise<GAQLRow[] | null> {
    try {
      return await query(true);
    } catch (error) {
      if (!(error instanceof GoogleQueryError) || error.status !== 400) {
        context.failures.push(this.stepFailure(context.step, error));
        return null;
      }

      this.logger.warn(
        `google.${context.label}_fields_rejected customer=${context.adAccount.externalAccountId} — relendo com menos campos`,
      );

      try {
        return await query(false);
      } catch (retryError) {
        context.failures.push(this.stepFailure(context.step, retryError));
        return null;
      }
    }
  }

  /**
   * Categorias das metas lançáveis por campanha.
   *
   * **Leitura acessória:** falha não vai para `stepFailures`, porque não diz
   * nada sobre o que arquivar. Devolve `null`, e `classifyGoogleCampaign`
   * trata a ausência como "não sei as metas" — lance manual vira tráfego, e
   * nenhuma conversão é cobrada sem certeza de que existe meta.
   */
  private async readConversionGoals(
    integration: Integration,
    adAccount: AdAccount,
    config: GoogleAdsConfig,
  ): Promise<Map<string, string[]> | null> {
    try {
      const rows = await this.runGAQL(
        integration,
        adAccount,
        config,
        CAMPAIGN_CONVERSION_GOALS_QUERY,
      );
      const byCampaign = new Map<string, string[]>();
      for (const row of rows) {
        const campaignId = row.campaign?.id;
        const category = row.campaignConversionGoal?.category;
        if (!campaignId || !category) continue;
        const list = byCampaign.get(String(campaignId)) ?? [];
        list.push(category);
        byCampaign.set(String(campaignId), list);
      }
      return byCampaign;
    } catch (error) {
      this.logger.warn(
        `google.conversion_goals_unavailable customer=${adAccount.externalAccountId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private stepFailure(
    step: ProviderFetchStep,
    error: unknown,
  ): ProviderStepFailure {
    const status = error instanceof GoogleQueryError ? error.status : null;
    const message = error instanceof Error ? error.message : String(error);

    this.logger.warn(
      `google.fetch_failed step=${step} status=${status ?? ''} ${message.slice(0, 300)}`,
    );

    return { step, message, status };
  }

  /**
   * Takes the config rather than re-reading env: the developer token is a required
   * credential, so it must come from a bundle that was already validated.
   */
  private buildHeaders(
    integration: Integration,
    config: GoogleAdsConfig,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${integration.accessToken}`,
      'developer-token': config.developerToken,
      'Content-Type': 'application/json',
    };

    if (config.loginCustomerId) {
      headers['login-customer-id'] = config.loginCustomerId;
    }

    return headers;
  }

  private async searchCustomer(
    integration: Integration,
    customerId: string,
    config: GoogleAdsConfig,
  ): Promise<{
    descriptiveName?: string;
    currencyCode?: string;
    timeZone?: string;
    manager?: boolean;
    testAccount?: boolean;
  }> {
    const url = `${this.adsBase}/customers/${customerId}/googleAds:searchStream`;
    const query = `
      SELECT
        customer.descriptive_name,
        customer.currency_code,
        customer.time_zone,
        customer.manager,
        customer.test_account
      FROM customer LIMIT 1
    `;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(integration, config),
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      await this.throwApiError(response, 'GOOGLE_CUSTOMER_LOOKUP_FAILED');
    }
    const body = (await response.json()) as Array<{
      results?: Array<{ customer?: Record<string, unknown> }>;
    }>;
    const customer = body?.[0]?.results?.[0]?.customer ?? {};
    return customer as never;
  }

  /** `searchStream` devolve tudo numa resposta — não há página a percorrer. */
  private async runGAQL(
    integration: Integration,
    adAccount: AdAccount,
    config: GoogleAdsConfig,
    query: string,
  ): Promise<GAQLRow[]> {
    const url = `${this.adsBase}/customers/${adAccount.externalAccountId}/googleAds:searchStream`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(integration, config),
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GoogleQueryError(response.status, text.slice(0, 500));
    }
    const body = (await response.json()) as Array<{ results?: GAQLRow[] }>;
    const out: GAQLRow[] = [];
    for (const chunk of body ?? []) {
      for (const row of chunk.results ?? []) {
        out.push(row);
      }
    }
    return out;
  }

  private toMetric(
    level: MetricLevel,
    externalEntityId: string,
    row: GAQLRow,
    refs: {
      campaignExternalId?: string | null;
      adSetExternalId?: string | null;
      adExternalId?: string | null;
      creativeExternalId?: string | null;
    },
  ): ProviderMetricRow {
    const m: GoogleMetricsNode = row.metrics ?? {};
    const spend = m.costMicros ? Number(m.costMicros) / 1_000_000 : 0;
    const impressions = Number(m.impressions ?? 0);
    const clicks = Number(m.clicks ?? 0);
    const conversions = Number(m.conversions ?? 0);
    const revenue = Number(m.conversionsValue ?? 0);
    const videoQuartileP25 = optionalNumber(m.videoQuartileP25Rate);
    const videoQuartileP100 = optionalNumber(m.videoQuartileP100Rate);
    return {
      // `YYYY-MM-DD` com fuso explícito: a data é o dia da conta, e não pode
      // depender do fuso da máquina que roda o ingest.
      date: new Date(`${row.segments?.date}T00:00:00.000Z`),
      level,
      externalEntityId,
      campaignExternalId: refs.campaignExternalId ?? null,
      adSetExternalId: refs.adSetExternalId ?? null,
      adExternalId: refs.adExternalId ?? null,
      creativeExternalId: refs.creativeExternalId ?? null,
      spend,
      impressions,
      clicks,
      conversions,
      revenue,
      ctr: m.ctr ? Number(m.ctr) * 100 : null,
      cpc: m.averageCpc ? Number(m.averageCpc) / 1_000_000 : null,
      cpa: conversions > 0 ? spend / conversions : null,
      roas: spend > 0 && revenue > 0 ? revenue / spend : null,
      frequency: null,
      reach: null,
      // Ausente é `null`, não zero: anúncio de busca não tem visualização de
      // vídeo, e zero afirmaria que teve e ninguém assistiu.
      videoViews: optionalNumber(m.videoTrueviewViews),
      engagement: optionalNumber(m.engagements),
      // p25 é o proxy de "segurou a atenção logo no início" — o mesmo papel de
      // `video_play_actions` na Meta. holdRate reaproveita a fórmula de
      // Meta/TikTok (p100/p25): de quem passou do primeiro quarto, quantos
      // foram até o fim. Sem p25 medido, a razão não tem denominador confiável.
      thumbstopRate: videoQuartileP25,
      holdRate:
        videoQuartileP25 !== null &&
        videoQuartileP100 !== null &&
        videoQuartileP25 > 0
          ? videoQuartileP100 / videoQuartileP25
          : null,
    };
  }

  private async validateState(state: string): Promise<AuthorizationSubject> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verify(state);
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_GOOGLE_STATE',
        message: 'Google OAuth state invalid',
      });
    }
    const issued = Number(payload.iat ?? 0);
    if (
      payload.provider !== 'GOOGLE' ||
      payload.purpose !== 'connect-integration' ||
      typeof payload.sub !== 'string' ||
      Math.floor(Date.now() / 1000) - issued > STATE_TTL_SECONDS
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_GOOGLE_STATE',
        message: 'Google OAuth state invalid or expired',
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

  private async throwApiError(
    response: Response,
    code: string,
  ): Promise<never> {
    const text = await response.text().catch(() => '');
    throw new BadGatewayException({
      code,
      message: `Google Ads API error (${response.status})`,
      detail: text?.slice(0, 1000),
    });
  }
}

/**
 * Orçamento pelo `period`: `DAILY` é teto diário; `CUSTOM_PERIOD` é total do
 * período e vai para `lifetimeBudget`. Ler `amount_micros` como diário em
 * qualquer caso fazia um orçamento total entrar no ritmo como se fosse de um
 * dia.
 *
 * O orçamento compartilhado (`explicitly_shared`) fica declarado em
 * `metadata`: ele pertence a várias campanhas ao mesmo tempo.
 */
function toCampaign(
  row: GAQLRow,
  goalCategories: Map<string, string[]> | null,
): ProviderCampaign {
  const campaign: GoogleCampaignNode = row.campaign ?? {};
  const budget: GoogleBudgetNode = row.campaignBudget ?? {};
  const customPeriod = budget.period === 'CUSTOM_PERIOD';
  const campaignId = String(campaign.id);

  return {
    externalCampaignId: campaignId,
    name: campaign.name ?? campaignId,
    status: campaign.status ?? null,
    objective: campaign.advertisingChannelType ?? null,
    optimization: classifyGoogleCampaign({
      channelType: campaign.advertisingChannelType,
      biddingStrategyType: campaign.biddingStrategyType,
      // Leitura das metas falhou ⇒ `null` ("não sei"); campanha ausente do
      // resultado ⇒ `[]` ("não tem meta lançável").
      biddableGoalCategories:
        goalCategories === null ? null : (goalCategories.get(campaignId) ?? []),
    }),
    dailyBudget: customPeriod ? null : fromMicros(budget.amountMicros),
    lifetimeBudget: customPeriod ? fromMicros(budget.totalAmountMicros) : null,
    currency: null,
    startedAt: null,
    endedAt: null,
    metadata: budget.resourceName
      ? {
          budgetResourceName: budget.resourceName,
          budgetPeriod: budget.period ?? null,
          budgetExplicitlyShared: budget.explicitlyShared === true,
        }
      : null,
  };
}

/** Grupo de anúncios não tem orçamento próprio no Google (`budgetLevels`). */
function toAdGroup(
  row: GAQLRow,
  optimizationByCampaign: Map<string, OptimizationTarget | null>,
): ProviderAdSet {
  const adGroup: GoogleAdGroupNode = row.adGroup ?? {};
  const campaignId = String(row.campaign?.id);

  return {
    externalAdSetId: String(adGroup.id),
    campaignExternalId: campaignId,
    name: adGroup.name ?? String(adGroup.id),
    status: adGroup.status ?? null,
    optimizationGoal: adGroup.type ?? null,
    optimization: optimizationByCampaign.get(campaignId) ?? null,
    billingEvent: null,
    dailyBudget: null,
    lifetimeBudget: null,
  };
}

function toAd(row: GAQLRow): ProviderAd {
  const ad: GoogleAdNode = row.adGroupAd?.ad ?? {};
  const adId = String(ad.id);

  return {
    externalAdId: adId,
    adSetExternalId: String(row.adGroup?.id),
    campaignExternalId: String(row.campaign?.id),
    creativeExternalId: adId,
    name: ad.name ?? adId,
    // O equivalente do `effective_status` da Meta: `ENABLED` dentro de grupo ou
    // campanha pausada não entrega.
    status: googleDeliveryStatus({
      adStatus: row.adGroupAd?.status,
      adGroupStatus: row.adGroup?.status,
      campaignStatus: row.campaign?.status,
      approvalStatus: row.adGroupAd?.policySummary?.approvalStatus,
      reviewStatus: row.adGroupAd?.policySummary?.reviewStatus,
    }),
    updatedAt: null,
  };
}

function toCreative(row: GAQLRow): ProviderCreative {
  const ad: GoogleAdNode = row.adGroupAd?.ad ?? {};
  const rsa = ad.responsiveSearchAd ?? null;
  /** O anúncio que não é de busca: o texto mora no nó do formato dele. */
  const display = ad.responsiveDisplayAd ?? ad.demandGenMultiAssetAd ?? null;
  const video = ad.videoResponsiveAd ?? null;

  return {
    externalCreativeId: String(ad.id),
    name: ad.name ?? null,
    title:
      rsa?.headlines?.[0]?.text ??
      display?.headlines?.[0]?.text ??
      video?.headlines?.[0]?.text ??
      null,
    body:
      rsa?.descriptions?.[0]?.text ??
      display?.descriptions?.[0]?.text ??
      video?.descriptions?.[0]?.text ??
      null,
    /**
     * Busca não tem chamada para ação; display, Demand Gen e o vídeo
     * responsivo têm — os dois primeiros como texto fixo, o vídeo como asset
     * rotativo (só o primeiro é lido, pela mesma razão de `title`/`body`).
     * É o campo que `REPLACE_CTA` lê para saber o que está no ar hoje.
     */
    callToAction:
      display?.callToActionText ??
      ad.demandGenCarouselAd?.callToActionText ??
      video?.callToActions?.[0]?.text ??
      null,
    format: ad.type ?? null,
    thumbnailUrl: ad.imageAd?.imageUrl ?? null,
    // O ativo de vídeo do Google é um resource name, não uma URL: entregá-lo
    // aqui faria a extração de quadro tentar baixar algo que não é endereço.
    videoUrl: null,
    imageUrl: ad.imageAd?.imageUrl ?? null,
    landingPageUrl: ad.finalUrls?.[0] ?? null,
    /**
     * Todos os títulos e descrições, na ordem da plataforma.
     *
     * `title` e `body` guardam só o primeiro de cada, e a troca de copy no
     * Google é **de um asset escolhido**: a tela precisa listar todos para a
     * pessoa escolher qual substituir, e a escrita confere o índice e o texto.
     */
    metadata:
      rsa || video
        ? {
            copyAssets: {
              headlines: textAssets(rsa?.headlines ?? video?.headlines),
              descriptions: textAssets(
                rsa?.descriptions ?? video?.descriptions,
              ),
            },
          }
        : null,
  };
}

/**
 * O grupo de recursos como unidade: pende direto da campanha, e o criativo dele
 * é o pacote de recursos, com o mesmo id.
 */
function toAssetGroupAd(row: GAQLRow): ProviderAd {
  const assetGroup: GoogleAssetGroupNode = row.assetGroup ?? {};
  const unitId = googleAssetGroupExternalId(String(assetGroup.id));

  return {
    externalAdId: unitId,
    adSetExternalId: null,
    campaignExternalId: String(row.campaign?.id),
    creativeExternalId: unitId,
    unitKind: 'ASSET_GROUP',
    name: assetGroup.name ?? unitId,
    // A mesma composição do anúncio, sem o nível do meio: grupo ligado em
    // campanha pausada não entrega.
    status: googleDeliveryStatus({
      adStatus: assetGroup.status,
      campaignStatus: row.campaign?.status,
    }),
    updatedAt: null,
  };
}

/** Um recurso de texto, com a chave que casa a classificação do Google. */
type TextAssetRef = { text: string; key: string | null };

type AssetBundle = {
  headlines: TextAssetRef[];
  longHeadlines: TextAssetRef[];
  descriptions: TextAssetRef[];
  businessName: string | null;
  callToAction: string | null;
  imageUrls: string[];
  youtubeVideoIds: string[];
};

const emptyBundle = (): AssetBundle => ({
  headlines: [],
  longHeadlines: [],
  descriptions: [],
  businessName: null,
  callToAction: null,
  imageUrls: [],
  youtubeVideoIds: [],
});

/** Os tipos de campo que carregam imagem — o nome muda com a proporção. */
const IMAGE_FIELD_TYPES = new Set([
  'MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'TALL_PORTRAIT_MARKETING_IMAGE',
]);

function bundleAssets(assetRows: GAQLRow[]): Map<string, AssetBundle> {
  const bundles = new Map<string, AssetBundle>();

  for (const row of assetRows) {
    const assetGroupId = row.assetGroup?.id;
    const fieldType = row.assetGroupAsset?.fieldType;
    if (!assetGroupId || !fieldType) continue;

    const bundle = bundles.get(String(assetGroupId)) ?? emptyBundle();
    const text = row.asset?.textAsset?.text?.trim() || null;
    const ref = text ? { text, key: assetKey(row) } : null;

    if (fieldType === 'HEADLINE' && ref) bundle.headlines.push(ref);
    if (fieldType === 'LONG_HEADLINE' && ref) bundle.longHeadlines.push(ref);
    if (fieldType === 'DESCRIPTION' && ref) bundle.descriptions.push(ref);
    if (fieldType === 'BUSINESS_NAME' && text) bundle.businessName = text;
    if (fieldType === 'CALL_TO_ACTION_SELECTION') {
      bundle.callToAction =
        row.asset?.callToActionAsset?.callToAction ?? bundle.callToAction;
    }
    if (IMAGE_FIELD_TYPES.has(fieldType)) {
      const url = row.asset?.imageAsset?.fullSize?.url;
      if (url) bundle.imageUrls.push(url);
    }
    if (fieldType === 'YOUTUBE_VIDEO') {
      const videoId = row.asset?.youtubeVideoAsset?.youtubeVideoId;
      if (videoId) bundle.youtubeVideoIds.push(videoId);
    }

    bundles.set(String(assetGroupId), bundle);
  }

  return bundles;
}

/**
 * O pacote de recursos como criativo.
 *
 * `title`, `body` e imagem são o **primeiro** de cada tipo, como no anúncio
 * responsivo — é o que as telas e o hash de conteúdo leem. A lista inteira vai
 * para `metadata.copyAssets`, no mesmo formato do anúncio de busca, para o Copy
 * Studio enxergar o que está no ar.
 *
 * `format` é o canal, não um tipo de anúncio: é por ele que as ações recortam o
 * que vale para o grupo, e nenhum recorte de formato do Google o inclui.
 *
 * Cada recurso de texto leva a classificação do Google (`performanceLabel`),
 * `null` quando ela não veio. É a leitura da plataforma sobre o recurso, não um
 * número derivado pela Allva — e, aqui, o criativo é de uma unidade só, então
 * não há média entre anúncios escondida nela.
 */
function toAssetGroupCreatives(
  structureRows: GAQLRow[],
  assetRows: GAQLRow[],
  labels: Map<string, string> | null,
): ProviderCreative[] {
  const bundles = bundleAssets(assetRows);

  return structureRows.map((row) => {
    const assetGroup: GoogleAssetGroupNode = row.assetGroup ?? {};
    const bundle = bundles.get(String(assetGroup.id)) ?? emptyBundle();
    const indexed = (refs: TextAssetRef[]) =>
      refs.map((ref, index) => ({
        index,
        text: ref.text,
        pinnedField: null,
        performanceLabel: (ref.key && labels?.get(ref.key)) || null,
      }));

    return {
      externalCreativeId: googleAssetGroupExternalId(String(assetGroup.id)),
      name: assetGroup.name ?? null,
      title: bundle.headlines[0]?.text ?? null,
      body: bundle.descriptions[0]?.text ?? null,
      callToAction: bundle.callToAction,
      format: PERFORMANCE_MAX,
      thumbnailUrl: bundle.imageUrls[0] ?? null,
      // O vídeo é um id do YouTube, não uma URL de arquivo: a extração de
      // quadro não tem o que baixar.
      videoUrl: null,
      imageUrl: bundle.imageUrls[0] ?? null,
      landingPageUrl: assetGroup.finalUrls?.[0] ?? null,
      metadata: {
        copyAssets: {
          headlines: indexed(bundle.headlines),
          descriptions: indexed(bundle.descriptions),
          longHeadlines: indexed(bundle.longHeadlines),
        },
        businessName: bundle.businessName,
        imageCount: bundle.imageUrls.length,
        youtubeVideoIds: bundle.youtubeVideoIds,
        adStrength: assetGroup.adStrength ?? null,
      },
    };
  });
}

/**
 * CTR e CPC derivados quando a consulta enxuta não os trouxe. Mesmas unidades
 * da API (CTR em fração, CPC em micros), para `toMetric` tratar igual.
 */
function withDerivedRates(
  metrics: GoogleMetricsNode | undefined,
): GoogleMetricsNode {
  const m = metrics ?? {};
  const impressions = Number(m.impressions ?? 0);
  const clicks = Number(m.clicks ?? 0);
  const costMicros = Number(m.costMicros ?? 0);

  return {
    ...m,
    ctr: m.ctr ?? (impressions > 0 ? clicks / impressions : undefined),
    averageCpc: m.averageCpc ?? (clicks > 0 ? costMicros / clicks : undefined),
  };
}

function textAssets(
  assets: GoogleTextAsset[] | undefined,
): Array<{ index: number; text: string; pinnedField: string | null }> {
  return (assets ?? []).map((asset, index) => ({
    index,
    text: asset.text ?? '',
    pinnedField: asset.pinnedField ?? null,
  }));
}

/** Linha de métrica sem dia não tem onde aterrissar na série. */
function dated(rows: GAQLRow[]): GAQLRow[] {
  return rows.filter((row) => typeof row.segments?.date === 'string');
}

function fromMicros(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1_000_000 : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
