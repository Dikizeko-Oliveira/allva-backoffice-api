import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdSyncState } from '../ad-sync-state';
import type {
  AdDetailView,
  AdListItemView,
  AdRef,
  AdSnapshotView,
  AdStatus,
  DataMaturity,
} from '../read-models/ad-views';

/**
 * As cinco ordenações de §7.1.
 *
 * O padrão é `avoidableDaily`: rankeia pelo que o usuário **pode interromper
 * hoje**, não pelo que já perdeu. Ordenar por dano acumulado põe no topo o
 * anúncio que mais gastou no passado — informação verdadeira e inútil, porque
 * não há o que fazer com ela.
 */
export const AD_SORT_FIELDS = [
  'avoidableDaily',
  'wasteAmount',
  'aiScore',
  'spend',
  'scoreDelta',
] as const;

export type AdSortField = (typeof AD_SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

/** Os 16 filtros de §7.1. */
export type AdListFilters = {
  platform?: Platform;
  adAccountId?: string;
  campaignId?: string;
  adSetId?: string;
  creativeId?: string;
  status?: AdStatus;
  syncState?: AdSyncState;
  archived?: boolean;
  hasOpenWaste?: boolean;
  hasOpenOpportunity?: boolean;
  minWasteAmountBase?: number;
  scoreBelow?: number;
  scoreDroppedBy?: number;
  confidenceAbove?: number;
  dataMaturity?: DataMaturity;
  lineageId?: string;
};

export type AdListQuery = AdListFilters & {
  organizationId: string;
  sortBy: AdSortField;
  sortDirection: SortDirection;
  limit: number;
  /**
   * Os valores de ordenação da última linha da página anterior, mais o `id` de
   * desempate. Declarado aqui em vez de importado do cursor HTTP: o domínio não
   * conhece a codificação, só a forma da chave (§16.6).
   */
  cursor?: { keys: (string | number | boolean | null)[]; id: string };
};

/**
 * O resultado da listagem, com o que a procedência exige declarar.
 *
 * `excludedByFloor` não é estatística: §12.4 manda **declarar quantos ficaram de
 * fora da ordenação** por estarem abaixo do piso de confiança. Sem o número, uma
 * lista curta é indistinguível de uma conta saudável — e o produto estaria
 * escondendo anúncios sem dizer.
 */
export type AdListResult = {
  items: AdListItemView[];
  hasMore: boolean;
  excludedByFloor: number;
};

export type AdSeriesQuery = {
  organizationId: string;
  adId: string;
  since: Date;
  until: Date;
  /**
   * Padrão `true` (§7.1). Recriação de anúncio é evento nosso, não do usuário:
   * a série que ele espera ver é a da intenção publicitária, não a do id.
   */
  followLineage: boolean;
};

export type AdHistoryEntry = {
  at: Date;
  kind: 'DISCOVERED' | 'DERIVED' | 'STATUS_CHANGED' | 'SYNCED' | 'ARCHIVED';
  summary: string;
  details: Record<string, unknown> | null;
};

/**
 * Leitura do agregado `Ad` — **read models dedicados, sem hidratar entidade**
 * (§5.5).
 *
 * A tela principal filtra por score e ordena por delta dentro de p95 < 400 ms
 * com 10k anúncios. Hidratar o agregado para isso significaria carregar série e
 * achados de cada linha para descartá-los em seguida; a denormalização em `ads`
 * existe justamente para a consulta ser um `SELECT` com `WHERE` e `ORDER BY`
 * que o índice cobre.
 */
export abstract class AdsRepositoryInterface {
  abstract list(query: AdListQuery): Promise<AdListResult>;

  abstract findDetail(
    organizationId: string,
    adId: string,
  ): Promise<AdDetailView | null>;

  abstract findRef(organizationId: string, adId: string): Promise<AdRef | null>;

  abstract series(query: AdSeriesQuery): Promise<AdSnapshotView[]>;

  abstract history(
    organizationId: string,
    adId: string,
    followLineage: boolean,
  ): Promise<AdHistoryEntry[]>;

  /** Os anúncios de uma linhagem, do mais antigo ao mais novo. */
  abstract lineageMembers(
    organizationId: string,
    lineageId: string,
  ): Promise<AdRef[]>;
}
