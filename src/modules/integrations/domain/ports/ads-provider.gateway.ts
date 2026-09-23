import { Integration } from '../entities/integration.entity';
import { AdAccount } from '../entities/ad-account.entity';
import { Platform } from '../entities/platform';
import type { OptimizationTarget } from '../entities/optimization-target';
import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';

export type MetricLevel = 'CAMPAIGN' | 'ADSET' | 'AD' | 'CREATIVE';

export type ProviderTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
};

export type ExternalAdAccount = {
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

export type DateRange = {
  since: Date;
  until: Date;
};

export type ProviderMetricRow = {
  date: Date;
  level: MetricLevel;
  externalEntityId: string;
  campaignExternalId?: string | null;
  adSetExternalId?: string | null;
  adExternalId?: string | null;
  creativeExternalId?: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr?: number | null;
  cpc?: number | null;
  cpa?: number | null;
  roas?: number | null;
  frequency?: number | null;
  reach?: number | null;
  videoViews?: number | null;
  engagement?: number | null;
  thumbstopRate?: number | null;
  holdRate?: number | null;

  /**
   * Sinais de feedback negativo (§12.2, A2-S4) — encerram a dívida declarada.
   *
   * `null` **não é zero**: zero é "ninguém escondeu este anúncio", `null` é "a
   * plataforma não nos disse". `NegativeFeedbackRisk` opera sobre proxies
   * enquanto forem nulos, e se marca `proxyBased` — porque proxy não é a mesma
   * medida com menos confiança, é outra medida.
   */
  hides?: number | null;
  hideAllFor?: number | null;
  reports?: number | null;
  unlikes?: number | null;
};

/** @deprecated kept for backwards compatibility with Phase 2 callers. Prefer ProviderMetricRow. */
export type ProviderCampaignMetric = ProviderMetricRow & {
  campaignName?: string;
};

export type ProviderCampaign = {
  externalCampaignId: string;
  name: string;
  status?: string | null;
  objective?: string | null;
  /**
   * O objetivo **traduzido** para a taxonomia canônica
   * (`optimization-target.ts`). É o provider quem traduz, porque só ele conhece
   * o vocabulário da plataforma (P6). Ausente = "não li" — o upsert preserva o
   * que já estava gravado em vez de apagar.
   */
  optimization?: OptimizationTarget | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  currency?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

export type ProviderAdSet = {
  externalAdSetId: string;
  campaignExternalId: string;
  name: string;
  status?: string | null;
  optimizationGoal?: string | null;
  billingEvent?: string | null;
  /** A meta de otimização do conjunto, traduzida. Ver `ProviderCampaign.optimization`. */
  optimization?: OptimizationTarget | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  targeting?: Record<string, unknown> | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

export type ProviderAd = {
  externalAdId: string;
  /**
   * Nulo quando a unidade pende direto da campanha — o grupo de recursos do
   * Performance Max. Nas plataformas com conjunto obrigatório, nulo não
   * acontece: o anúncio sem conjunto resolvido vai para a quarentena.
   */
  adSetExternalId: string | null;
  campaignExternalId: string;
  /** Ausente = `AD`. Ver `ad-unit.ts`. */
  unitKind?: AdUnitKind;
  creativeExternalId?: string | null;
  name: string;
  status?: string | null;
  /**
   * Instante **do dado na plataforma** (A2-S3, §8.4.1). Alimenta `observedAsOf`
   * e, com ele, a guarda de recência. Nulo nas plataformas cujo perfil declara
   * `exposesDataTimestamp: false` — aí a guarda cai para o início da janela de
   * leitura como limite inferior seguro (B4).
   */
  updatedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
};

export type ProviderCreative = {
  externalCreativeId: string;
  name?: string | null;
  title?: string | null;
  body?: string | null;
  callToAction?: string | null;
  format?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  imageUrl?: string | null;
  landingPageUrl?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Etapas que o provider reporta individualmente (A2-S3, §8.2 passo 11). */
export type ProviderFetchStep =
  | 'INSIGHTS'
  | 'CAMPAIGNS'
  | 'AD_SETS'
  | 'ADS'
  | 'CREATIVES';

export type ProviderStepFailure = {
  step: ProviderFetchStep;
  message: string;
  /** Status HTTP, quando houve resposta. Distingue 403 de timeout. */
  status?: number | null;
};

export type ProviderSyncResult = {
  metrics: ProviderMetricRow[];
  campaigns: ProviderCampaign[];
  adSets?: ProviderAdSet[];
  ads?: ProviderAd[];
  creatives?: ProviderCreative[];

  /**
   * **A resposta cobriu o escopo pedido inteiro** (A2-S3, §8.2 passo 9).
   *
   * É o único insumo que autoriza arquivar o que não veio. Declarado pelo
   * provider e nunca inferido: "a chamada não lançou" não é a mesma coisa que
   * "a leitura foi completa" — um `fetch` que devolve lista vazia em cima de um
   * 403 satisfaz a primeira e viola a segunda, e essa exata confusão arquivaria
   * a conta inteira.
   */
  wasComplete: boolean;

  /** O que falhou, por etapa. Vai para `SyncOperation.stepResults`. */
  stepFailures?: ProviderStepFailure[];

  /**
   * Cursor de retomada por etapa; ausente quando a etapa terminou. Persistido em
   * `SyncOperation.checkpoints` a cada página.
   */
  checkpoints?: Record<string, string | null>;
};

export type SyncOptions = {
  levels?: MetricLevel[];
  /**
   * Estrutura incremental (§8.2 passo 4). Só é honrado por plataforma cujo
   * perfil declara `sync.supportsUpdatedSince`; as demais recebem o valor e o
   * ignoram, e o motor filtra o resultado — o custo é de chamada, não de
   * correção.
   */
  updatedSince?: Date | null;
  /** ② Refresh dirigido: coalesce ids da mesma conta numa chamada só (§8.3). */
  adExternalIds?: string[];
};

export type AuthorizationContext = {
  accountId: string;
  /**
   * A organização **escolhida** por quem está conectando.
   *
   * Vai no `state` assinado e volta no callback. Sem ela, a organização era
   * resolvida no retorno pela participação ativa mais antiga da conta — o que
   * ignorava o seletor de workspace e gravava a credencial na organização
   * errada para quem participa de mais de uma.
   */
  organizationId?: string;
};

/**
 * O que o callback recupera do `state` que ele mesmo assinou.
 *
 * `organizationId` é opcional porque `state` emitido antes desta mudança não o
 * carrega: um usuário no meio do fluxo quando o deploy acontece completa a
 * conexão pelo caminho antigo em vez de receber erro.
 */
export type AuthorizationSubject = {
  accountId: string;
  organizationId: string | null;
};

/**
 * Port como `abstract class`, e não `interface` (§16.6, harness de A2-S0).
 *
 * A convenção vale em todo o repositório por um motivo prático: uma interface
 * some na compilação, então não pode ser token de injeção nem ser verificada em
 * runtime — o wiring passa a depender de string mágica, e o teste de camadas
 * não tem o que inspecionar. Era o único port do `src/` ainda como interface.
 */
export abstract class AdsProviderGateway {
  abstract readonly platform: Platform;

  abstract isConfigured(): boolean;

  abstract getAuthorizationUrl(context: AuthorizationContext): Promise<string>;

  abstract exchangeCodeForToken(
    code: string,
    state: string,
  ): Promise<{
    token: ProviderTokenResult;
    accountId: string;
    /** A organização escolhida na ida, recuperada do `state`. */
    organizationId: string | null;
  }>;

  abstract refreshAccessToken(
    integration: Integration,
  ): Promise<ProviderTokenResult>;

  abstract listAdAccounts(
    integration: Integration,
  ): Promise<ExternalAdAccount[]>;

  abstract syncAdAccountMetrics(
    adAccount: AdAccount,
    integration: Integration,
    dateRange: DateRange,
    options?: SyncOptions,
  ): Promise<ProviderSyncResult>;

  abstract revokeToken(integration: Integration): Promise<void>;
}
