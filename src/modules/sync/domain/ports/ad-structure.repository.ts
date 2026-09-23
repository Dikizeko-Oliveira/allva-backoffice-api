import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';
import type { AdLineageOrigin } from 'src/modules/ads/domain/ports/ad-lineage-origin.reader';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import type { DataMaturity } from '../data-maturity';

/**
 * Escrita da hierarquia sincronizada — campanha, conjunto, criativo e anúncio.
 *
 * **Upsert em ordem de FK, resolvendo external ids por `adAccountId`** (§8.2
 * passo 5, P10). Nunca por `integrationId`: a credencial é substituível, e
 * ancorar a identidade nela é o bug que a v2.0 existe para corrigir.
 */

export type UpsertCampaignInput = {
  adAccountId: string;
  organizationId: string;
  integrationId: string;
  platform: Platform;
  externalCampaignId: string;
  name: string;
  status: string | null;
  objective: string | null;
  /**
   * O objetivo traduzido pelo provider. `undefined` = o provider não leu, e o
   * valor gravado é preservado — apagar por ausência de leitura faria um sync
   * parcial esquecer para que a campanha foi otimizada.
   */
  optimization?: OptimizationTarget | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string;
  startedAt: Date | null;
  endedAt: Date | null;
  metadata: Record<string, unknown> | null;
};

export type UpsertAdSetInput = {
  adAccountId: string;
  organizationId: string;
  campaignId: string;
  platform: Platform;
  externalAdSetId: string;
  name: string;
  status: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  /** Ver `UpsertCampaignInput.optimization`. */
  optimization?: OptimizationTarget | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  targeting: Record<string, unknown> | null;
};

export type UpsertCreativeInput = {
  adAccountId: string;
  organizationId: string;
  platform: Platform;
  externalCreativeId: string;
  name: string | null;
  title: string | null;
  body: string | null;
  callToAction: string | null;
  format: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  imageUrl: string | null;
  landingPageUrl: string | null;
  /** §11 — a impressão digital do conteúdo, base de `OVERLAPPING_DELIVERY`. */
  contentHash: string;
  metadata: Record<string, unknown> | null;
};

export type UpsertAdInput = {
  /**
   * A origem, quando este anúncio sucede outro que uma ação nossa recriou
   * (§9.5 passo 6). Só é lida na **criação** — um anúncio já existente tem
   * linhagem, e reescrevê-la mudaria a série debaixo de quem já a leu.
   */
  lineageOrigin?: AdLineageOrigin | null;
  adAccountId: string;
  accountId: string;
  organizationId: string;
  integrationId: string;
  platform: Platform;
  externalAdId: string;
  campaignId: string;
  adSetId: string | null;
  creativeId: string | null;
  name: string;
  /** A unidade não muda de natureza: gravada na criação e reafirmada a cada leitura. */
  unitKind: AdUnitKind;
  observedStatus: AdStatus;
  observedRawStatus: string | null;
  observedAsOf: Date;
  /**
   * `false` quando a guarda de recência recusou a observação (§8.4.1): grava
   * métricas e **preserva** o status local, que descreve uma intenção mais nova.
   */
  writeObservedStatus: boolean;
  lastStructureSyncAt: Date;
  metadata: Record<string, unknown> | null;
};

/**
 * O que o upsert devolve — **só a identidade**.
 *
 * `created`, `previousObservedStatus` e `desiredStatus` não vêm daqui de
 * propósito: quem chama já leu o estado anterior da conta inteira em uma
 * consulta, e pedir de volta linha a linha significaria uma ida ao banco por
 * anúncio. Numa conta de 5 mil, é a diferença entre caber e não caber no alvo de
 * < 5 min de §17.2.
 */
export type UpsertedAd = {
  id: string;
  lineageId: string;
};

export type AdSyncSnapshot = {
  id: string;
  organizationId: string;
  adAccountId: string;
  externalAdId: string;
  lineageId: string;
  observedStatus: AdStatus;
  observedAsOf: Date | null;
  desiredStatus: AdStatus | null;
  desiredStatusSetAt: Date | null;
  syncState: string;
  driftDetails: Record<string, unknown> | null;
  lastMetricsSyncAt: Date | null;
  lastStructureSyncAt: Date | null;
  archivedAt: Date | null;
};

export abstract class AdStructureRepositoryInterface {
  abstract upsertCampaign(input: UpsertCampaignInput): Promise<string>;
  abstract upsertAdSet(input: UpsertAdSetInput): Promise<string>;
  abstract upsertCreative(input: UpsertCreativeInput): Promise<string>;
  abstract upsertAd(input: UpsertAdInput): Promise<UpsertedAd>;

  /** `externalId → id` das entidades já conhecidas da conta. */
  abstract mapCampaignIds(adAccountId: string): Promise<Map<string, string>>;
  abstract mapAdSetIds(adAccountId: string): Promise<Map<string, string>>;
  abstract mapCreativeIds(adAccountId: string): Promise<Map<string, string>>;

  abstract listAdsOfAccount(adAccountId: string): Promise<AdSyncSnapshot[]>;

  abstract findAdsByExternalIds(
    adAccountId: string,
    externalAdIds: string[],
  ): Promise<AdSyncSnapshot[]>;

  /** Ids internos, sempre com `organizationId` no filtro (§16.7). */
  abstract findAdsByIds(
    organizationId: string,
    adIds: string[],
  ): Promise<AdSyncSnapshot[]>;

  /**
   * Os anúncios que a reconciliação precisa olhar: os com intenção em voo
   * (drift, §8.5a) e os vistos recentemente (mudança externa, §8.5b).
   */
  abstract listForReconciliation(
    adAccountId: string,
  ): Promise<AdSyncSnapshot[]>;

  /**
   * Arquiva os anúncios não vistos — **só é chamado depois da guarda de §8.2**.
   *
   * O port não conhece a guarda: quem a aplica é o serviço de ingest. A
   * separação é deliberada — um repositório que decidisse sozinho quando pode
   * arquivar teria a regra mais importante do sprint escondida numa camada onde
   * ninguém a procura.
   */
  abstract archiveAdsNotSeen(input: {
    adAccountId: string;
    seenExternalAdIds: string[];
    archivedAt: Date;
  }): Promise<AdSyncSnapshot[]>;

  /** Denormalização de maturidade em `Ad.dataMaturity` (A9, §5.4). */
  abstract updateDataMaturity(
    updates: Array<{ adId: string; dataMaturity: DataMaturity | null }>,
  ): Promise<void>;

  /** Transição de `syncState` já validada pela máquina de I4. */
  abstract applySyncState(input: {
    adIds: string[];
    syncState: string;
    syncStateAt: Date;
    driftDetails?: Record<string, unknown> | null;
  }): Promise<void>;

  abstract touchMetricsSync(input: {
    adIds: string[];
    at: Date;
  }): Promise<void>;
}
