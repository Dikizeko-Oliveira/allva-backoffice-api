import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdUnitKind } from '../ad-unit';
import type { MoneyView } from 'src/shared/domain/money';
import type { AdSyncState } from '../ad-sync-state';
import type { SeriesDiscontinuityReason } from '../series-discontinuity';

export type AdStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'DELETED'
  | 'PENDING_REVIEW'
  | 'DISAPPROVED'
  | 'UNKNOWN';

export type DataMaturity = 'IMMATURE' | 'SETTLING' | 'MATURE';

/**
 * `AdRef` — a referência ao anúncio embutida em waste, recomendações, ações e
 * alertas (§7.5).
 *
 * Carrega **os dois estados**, observado e desejado, porque a diferença entre
 * eles é a informação: com um campo só, a tela não consegue dizer "pausando…" em
 * vez de "pausado", e o usuário conclui que a ação falhou quando ela está apenas
 * a caminho.
 */
export type AdRef = {
  id: string;
  lineageId: string;
  name: string;
  platform: Platform;
  externalAdId: string;
  /**
   * Anúncio ou grupo de recursos do Performance Max (D23). A tela precisa
   * saber para chamar a unidade pelo nome certo — e para não procurar um
   * conjunto que o grupo de recursos não tem.
   */
  unitKind: AdUnitKind;
  observedStatus: AdStatus;
  desiredStatus: AdStatus | null;
  syncState: AdSyncState;
  campaign: { id: string; name: string };
  adSet: { id: string; name: string } | null;
  creative: {
    id: string;
    thumbnailUrl: string | null;
    format: string | null;
  } | null;
};

/**
 * Uma linha da tela principal.
 *
 * Score, confiança e cobertura viajam **juntos** (D11): um score de 38 sem a
 * confiança ao lado convida a decisão que a confiança desaconselha, e a
 * cobertura é o que explica por que a confiança caiu numa plataforma que não
 * entrega metade dos sinais.
 */
export type AdListItemView = AdRef & {
  dataMaturity: DataMaturity | null;
  score: {
    value: number | null;
    confidence: number | null;
    /** `coverageRatio` — relativo ao `PlatformProfile`, nunca absoluto. */
    coverage: number | null;
    delta7d: number | null;
    asOf: Date | null;
  };
  waste: {
    openCount: number;
    /** O máximo entre os itens abertos — a única parcela somável (§10.6). */
    openAmount: MoneyView | null;
    /** O número acionável: o que dá para interromper hoje. */
    avoidableDaily: MoneyView | null;
    asOf: Date | null;
  };
  archivedAt: Date | null;
};

/** O agregado inteiro, com linhagem (`GET /ads/{id}`). */
export type AdDetailView = AdListItemView & {
  accountId: string;
  organizationId: string;
  adAccountId: string;
  observedAsOf: Date | null;
  desiredStatusSetAt: Date | null;
  syncStateAt: Date | null;
  lastStructureSyncAt: Date | null;
  lastMetricsSyncAt: Date | null;
  firstSeenAt: Date;
  lineage: {
    lineageId: string;
    originAdId: string | null;
    originActionExecutionId: string | null;
    /** Quantos anúncios a linhagem já teve, incluindo este. */
    generations: number;
  };
};

/** Um ponto da série diária (`GET /ads/{id}/metrics`). */
export type AdSnapshotView = {
  adId: string;
  date: Date;
  spend: MoneyView;
  revenue: MoneyView;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  frequency: number | null;
  /**
   * O **motivo** da descontinuidade, ou `null` (§12.5, A12).
   *
   * Declarado porque a série não pode ser lida através dele — e o motivo vai
   * junto porque "a série quebrou" sem causa não diz ao usuário se ele deve
   * investigar o anúncio ou se fomos nós que mudamos a régua.
   */
  seriesDiscontinuity: SeriesDiscontinuityReason | null;
  normalizationPending: boolean;
};

/**
 * Estado por seção (§7.5) — **sempre `200`**.
 *
 * Uma seção que ainda não tem dado devolve `PENDING` com motivo, nunca `404` nem
 * lista vazia. A distinção é o produto inteiro: "ainda não analisamos" e "não há
 * desperdício" levam a decisões opostas, e achatá-las numa lista vazia faz o
 * usuário concluir a segunda quando a verdade é a primeira.
 */
export type SectionStatus = 'OK' | 'PENDING' | 'UNAVAILABLE' | 'EMPTY';

export type Section<T> = {
  status: SectionStatus;
  /** Obrigatório quando o status não é `OK` — o motivo é a informação (P7). */
  reason?: string;
  data?: T;
};

export function sectionOk<T>(data: T): Section<T> {
  return { status: 'OK', data };
}

export function sectionPending<T>(reason: string): Section<T> {
  return { status: 'PENDING', reason };
}

export function sectionUnavailable<T>(reason: string): Section<T> {
  return { status: 'UNAVAILABLE', reason };
}

export function sectionEmpty<T>(reason: string): Section<T> {
  return { status: 'EMPTY', reason };
}
