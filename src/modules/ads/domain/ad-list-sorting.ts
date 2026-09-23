import { SCORE_FLOORS } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { AdSortField, SortDirection } from './ports/ads.repository';

/**
 * Como cada ordenação de §7.1 vira coluna, direção e piso de confiança.
 *
 * Está separado do repositório de propósito: é regra de produto — qual coluna
 * ordena, que piso se aplica, para que lado o "melhor" fica — e regra de produto
 * testável sem banco vale mais que regra de produto correta dentro de uma query
 * de 60 linhas.
 */
export type SortSpec = {
  /** Coluna denormalizada em `ads`, escrita pelo dono declarado em §5.4. */
  column:
    | 'avoidableDailyAmountBase'
    | 'openWasteAmountBase'
    | 'currentAiScore'
    | 'currentScoreConfidence'
    | 'scoreDelta7d';
  /** A direção que põe "o que mais importa" no topo quando não se pede outra. */
  defaultDirection: SortDirection;
  /**
   * Piso de §12.4, quando a ordenação depende do score. `null` para as que
   * ordenam por dinheiro observado — gasto não tem confiança, tem valor.
   */
  floor: { minConfidence: number; minCoverageRatio: number } | null;
};

export const AD_SORT_SPECS: Readonly<Record<AdSortField, SortSpec>> = {
  /**
   * O padrão. Ordena pelo que se pode interromper hoje; não tem piso porque o
   * número vem de gasto observado, não de score.
   */
  avoidableDaily: {
    column: 'avoidableDailyAmountBase',
    defaultDirection: 'desc',
    floor: null,
  },
  wasteAmount: {
    column: 'openWasteAmountBase',
    defaultDirection: 'desc',
    floor: null,
  },
  /** Score baixo primeiro: a lista existe para achar o que está mal. */
  aiScore: {
    column: 'currentAiScore',
    defaultDirection: 'asc',
    floor: SCORE_FLOORS.scoreOrdering,
  },
  /** Queda mais forte primeiro — e o piso é mais alto que o de `aiScore`. */
  scoreDelta: {
    column: 'scoreDelta7d',
    defaultDirection: 'asc',
    floor: SCORE_FLOORS.deltaOrdering,
  },
  /**
   * Ordenar por gasto é ordenar pela série, não por `ads`. A denormalização de
   * gasto não existe (e não deve existir: gasto tem janela, e a coluna não
   * teria dimensão de janela — o mesmo erro que D20 recusou para waste).
   * `spend` cai para o valor incorrido, que é o que a linha já carrega.
   */
  spend: {
    column: 'openWasteAmountBase',
    defaultDirection: 'desc',
    floor: null,
  },
};

/**
 * Os filtros que dependem de score e, por isso, arrastam piso junto.
 *
 * `?scoreBelow=` sem piso devolveria como "pior anúncio da conta" aquele cujo
 * score é baixo **porque quase não há dado** — e o usuário pausaria o anúncio
 * errado com a nossa assinatura embaixo.
 */
export function floorForQuery(input: {
  sortBy: AdSortField;
  scoreBelow?: number;
  scoreDroppedBy?: number;
}): SortSpec['floor'] {
  if (input.scoreDroppedBy !== undefined) return SCORE_FLOORS.deltaOrdering;
  if (input.scoreBelow !== undefined) return SCORE_FLOORS.scoreOrdering;
  return AD_SORT_SPECS[input.sortBy].floor;
}

/** A chave estável do cursor: a coluna ordenada mais o `id` como desempate. */
export function sortKeyFor(sortBy: AdSortField, direction: SortDirection) {
  return `${sortBy}:${direction}`;
}
