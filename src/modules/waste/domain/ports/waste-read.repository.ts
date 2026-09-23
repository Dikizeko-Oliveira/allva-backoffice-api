import type { ResolvedOptimization } from 'src/modules/integrations/domain/entities/optimization-target';
import type { EvidenceGap, EvidenceGapNature } from '../evidence-gaps';
import type { EvidenceGapCode } from '../detection-context';
import type { MoneyView } from 'src/shared/domain/money';
import type { EvidenceSufficiency } from 'src/shared/domain/provenance';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import type {
  FindingKind,
  FindingType,
  ScopeLevel,
  WastePriority,
  WasteResolutionKind,
} from '../contracts/finding-catalog';

/**
 * Os read models de §10.8 — **derivados, nunca armazenados**.
 *
 * *"Nenhuma linha de desperdício agregada é armazenada. O contexto é sempre
 * derivado."* Toda agregação passa obrigatoriamente pela view `open_waste`, e é
 * a view — não a disciplina de quem escreve a consulta — que garante que
 * oportunidade jamais entre em total de desperdício.
 */

/** A referência ao anúncio embutida em todo achado (§7.5). */
export type WasteAdRef = {
  id: string;
  lineageId: string;
  name: string;
  platform: string;
  externalAdId: string;
  observedStatus: string;
  campaign: { id: string; name: string };
  adSet: { id: string; name: string } | null;
};

export type WasteItemView = {
  id: string;
  ad: WasteAdRef;
  type: FindingType;
  findingKind: FindingKind;
  priority: WastePriority;
  windowDays: number;

  /**
   * As duas grandezas, sempre juntas (§10.1). `openAmount` **deixou de existir**
   * na API: um número só fazia o produto prometer recuperar dinheiro que já foi.
   */
  incurred: MoneyView;
  avoidableDaily: MoneyView;

  diagnosis: string;
  evidence: Record<string, unknown>;
  evidenceSufficiency: EvidenceSufficiency;
  scopeLevel: ScopeLevel;
  dataMaturity: DataMaturity | null;
  detectorVersion: string;
  detectorProfileVersion: string;

  occurrences: number;
  detectedAt: Date;
  lastSeenAt: Date;
  /** Aberto sem observação válida: o número é velho e a tela precisa saber. */
  staleObservation: boolean;

  resolvedAt: Date | null;
  resolutionKind: WasteResolutionKind | null;
};

export type WasteListFilters = {
  organizationId: string;
  findingKind?: FindingKind;
  type?: FindingType;
  priority?: WastePriority;
  dataMaturity?: DataMaturity;
  adId?: string;
  adAccountId?: string;
  campaignId?: string;
  adSetId?: string;
  /** `open` (padrão) · `resolved` · `all`. */
  state?: 'open' | 'resolved' | 'all';
  minAvoidableDailyBase?: number;
};

export type WasteListQuery = WasteListFilters & {
  limit: number;
  cursor?: { keys: (string | number | boolean | null)[]; id: string };
};

export type WasteListResult = {
  items: WasteItemView[];
  hasMore: boolean;
};

/**
 * O resumo de `/waste/summary` — **par de grandezas, nunca uma**.
 *
 * Os totais monetários somam as colunas denormalizadas de `ads` (o `max` por
 * anúncio), jamais `waste_items.amount`: somar itens somaria entre tipos e
 * recriaria a dupla contagem no eixo do achado.
 */
export type WasteSummaryView = {
  openCount: number;
  affectedAds: number;
  incurred: MoneyView | null;
  avoidableDaily: MoneyView | null;
  byPriority: Record<WastePriority, number>;
  byType: Partial<Record<FindingType, number>>;
  asOf: Date | null;
  /** DEC-11: itens de janela diferente da vigente ficam fora e são contados. */
  excludedByWindowMismatch: number;
  /**
   * Achados abertos que a varredura **não reconfirmou** recentemente.
   *
   * ## Por que passou a existir
   *
   * Enquanto a régua da noite olhava sempre os mesmos anúncios, todo achado
   * aberto era reconfirmado toda madrugada e `lastSeenAt` era sempre de ontem.
   * Com o rodízio, um anúncio da cauda volta a cada N noites — e o achado dele
   * fica parado no meio-tempo. O problema pode ter acabado; ninguém olhou.
   *
   * ## Por que precisa aparecer, e não só existir
   *
   * O total de desperdício aberto é um **número sobre dinheiro**. Somar achado
   * confirmado hoje com achado visto há oitenta noites e apresentar o resultado
   * como "R$ X queimando agora" é a defasagem no pior lugar possível. Declarar a
   * parcela não reverificada é o que mantém o número honesto sem escondê-lo — a
   * mesma disciplina de `excludedByWindowMismatch`.
   */
  unverified: {
    count: number;
    /** O `lastSeenAt` mais antigo entre eles. `null` quando não há nenhum. */
    oldestSeenAt: Date | null;
  };
};

export type WasteRollupGroupBy =
  | 'campaign'
  | 'adSet'
  | 'platform'
  | 'adAccount';

export type WasteRollupRow = {
  groupId: string;
  groupName: string;
  affectedAds: number;
  openWasteBase: number;
  avoidableDailyBase: number;
  criticalItems: number;
};

export type WasteRollupResult = {
  rows: WasteRollupRow[];
  baseCurrency: string | null;
  excludedByWindowMismatch: number;
};

export type WasteByAdRow = {
  ad: WasteAdRef;
  openCount: number;
  incurred: MoneyView;
  avoidableDaily: MoneyView;
  types: FindingType[];
  worstPriority: WastePriority;
  wasteAsOf: Date | null;
};

/**
 * A divergência entre a denormalização e a agregação real (C3, §5.4 r.2).
 *
 * *"As denormalizações são cache, e cache diverge."* A agregação é a verdade; o
 * job corrige a coluna e emite o drift. Divergência recorrente é bug do worker,
 * não ruído — e sem este read model ela seria invisível por definição, porque a
 * tela lê exatamente a coluna que está errada.
 */
export type DenormalizationDrift = {
  adId: string;
  organizationId: string;
  stored: {
    openWasteCount: number;
    openWasteAmountBase: number;
    avoidableDailyAmountBase: number;
  };
  actual: {
    openWasteCount: number;
    openWasteAmount: number;
    openWasteAmountBase: number;
    openWasteCurrency: string | null;
    avoidableDailyAmountBase: number;
  };
};

/**
 * O que a detecção não pôde julgar num anúncio — o **silêncio explicado**.
 *
 * `evaluated: false` quando o ciclo ainda não passou pelo anúncio (ou ele não
 * entrega): aí não há o que explicar, e dizer "nenhuma lacuna" seria afirmar um
 * julgamento que não aconteceu.
 */
export type AdEvidenceView = {
  adId: string;
  optimization: ResolvedOptimization & { label: string };
  evaluated: boolean;
  gaps: EvidenceGap[];
  asOf: Date | null;
};

export type EvidenceGapCount = {
  code: EvidenceGapCode;
  nature: EvidenceGapNature;
  /** Anúncios com esta lacuna. */
  ads: number;
  /** A estimativa mais próxima entre eles. */
  nextReadyOn: string | null;
  /** Quantos, no ritmo atual, nunca juntam o mínimo. */
  unreachableAds: number;
};

export type EvidenceSummaryView = {
  /** Anúncios que entregam e que o último ciclo avaliou. */
  adsEvaluated: number;
  /** Com pelo menos uma lacuna que o tempo resolve. */
  adsAwaitingEvidence: number;
  /** Sem lacuna pendente nem estrutural: todo detector aplicável julgou. */
  adsFullyJudged: number;
  /** Com detector de conversão fora do escopo (objetivo ou evento). */
  adsOutsideConversionScope: number;
  byCode: EvidenceGapCount[];
  nextReadyOn: string | null;
  asOf: Date | null;
};

export abstract class WasteReadRepositoryInterface {
  abstract list(query: WasteListQuery): Promise<WasteListResult>;

  abstract findOne(
    organizationId: string,
    id: string,
  ): Promise<WasteItemView | null>;

  /** Os achados abertos de um anúncio (`GET /ads/{id}/waste`). */
  abstract openForAd(
    organizationId: string,
    adId: string,
  ): Promise<WasteItemView[]>;

  /**
   * **Desperdício apenas.** Não há resumo monetário de oportunidade na v2.0, e a
   * ausência é decisão: os totais somam as colunas denormalizadas de `ads`, que
   * guardam o `max` sobre achados `WASTE` (§10.6). Produzir um "total de
   * oportunidade" exigiria colunas que o schema não tem — e inventá-lo somando
   * `waste_items` recriaria a dupla contagem no eixo do tipo, do outro lado.
   */
  abstract summary(input: {
    organizationId: string;
    windowDays: number;
    adAccountId?: string;
  }): Promise<WasteSummaryView>;

  /**
   * O rollup de §10.8, com **subconsulta pré-agregada por anúncio**.
   *
   * A subconsulta não é otimização, é correção: somar uma coluna do lado 1 de um
   * join 1:N a multiplica pela cardinalidade do lado N, e um anúncio com três
   * achados abertos entraria três vezes no número de capa.
   */
  abstract rollup(input: {
    organizationId: string;
    groupBy: WasteRollupGroupBy;
    windowDays: number;
    limit: number;
  }): Promise<WasteRollupResult>;

  /**
   * `/waste/by-ad` — servido pela **denormalização**, não por agrupamento de
   * itens.
   *
   * Agrupar `waste_items` em memória partiria um anúncio entre duas páginas
   * sempre que seus achados caíssem em pontos diferentes da ordenação, e o total
   * do anúncio sairia errado na página em que ele aparecesse pela metade. As
   * colunas de `ads` já carregam o `max` de §10.6: paginar sobre elas é correto
   * **e** é o que sustenta o p95.
   */
  abstract byAd(input: {
    organizationId: string;
    limit: number;
    cursor?: { avoidableDailyBase: number; id: string };
  }): Promise<{ rows: WasteByAdRow[]; hasMore: boolean }>;

  /** `null` quando o anúncio não existe na organização. */
  abstract evidenceForAd(input: {
    organizationId: string;
    adId: string;
  }): Promise<AdEvidenceView | null>;

  abstract evidenceSummary(input: {
    organizationId: string;
    adAccountId?: string;
  }): Promise<EvidenceSummaryView>;

  abstract findDenormalizationDrift(input: {
    adAccountId: string;
  }): Promise<DenormalizationDrift[]>;
}
