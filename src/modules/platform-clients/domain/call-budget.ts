/**
 * O orçamento de chamadas de R4, como **aritmética verificável**.
 *
 * Existe por causa de uma entrega condicional: DEC-4 adia o reach deduplicado de
 * 7 dias para `AUDIENCE_SATURATION` *"se o orçamento de R4 comportar"*, e A2-S8
 * transferiu a entrega para A2-S9 precisamente porque a condição não era
 * avaliável por palpite. Decidir por estimativa de cabeça é decidir por palpite
 * sobre o risco que R4 nomeia.
 *
 * Isto não substitui a contagem real — `PlatformRateLimiterService` conta o que
 * de fato saiu, por integração. É o modelo contra o qual a contagem real é
 * comparada, e o que permite responder a pergunta **antes** de a primeira conta
 * grande existir.
 */

/** A estrutura de uma conta de anúncios, do ponto de vista do custo de leitura. */
export type AccountShape = {
  ads: number;
  adSets: number;
  /** Dias lidos por ciclo — a janela de re-declaração da conta (§8.9). */
  restatementWindowDays: number;
};

/**
 * Quantas linhas a Graph API devolve por página de insights.
 *
 * É `limit=500` no provider, e é o número que torna o custo **sublinear** no
 * tamanho da conta: insights são pedidos no nível da **conta** com
 * `level=ad`, não um pedido por anúncio.
 */
export const INSIGHTS_PAGE_SIZE = 500;

/** Chamadas de estrutura por ciclo completo: campanhas, conjuntos, anúncios, criativos. */
export const STRUCTURE_CALLS_PER_FULL_SYNC = 4;

export type CycleCost = {
  /** Páginas de insights no nível de anúncio, com `time_increment=1`. */
  insightsPages: number;
  structureCalls: number;
  total: number;
};

/**
 * O custo de um ciclo de ingest completo, em chamadas.
 *
 * `ads × dias / 500` porque a série é diária: cada anúncio produz uma linha por
 * dia da janela, e a paginação é sobre o total de linhas — não sobre anúncios.
 */
export function fullSyncCost(shape: AccountShape): CycleCost {
  const rows = shape.ads * Math.max(1, shape.restatementWindowDays);
  const insightsPages = Math.max(1, Math.ceil(rows / INSIGHTS_PAGE_SIZE));
  const structureCalls = STRUCTURE_CALLS_PER_FULL_SYNC;

  return {
    insightsPages,
    structureCalls,
    total: insightsPages + structureCalls,
  };
}

/**
 * O custo **incremental** do reach deduplicado de 7 dias (DEC-4, segunda metade).
 *
 * A chamada é no nível de **conjunto**, com `time_range` de 7 dias e **sem**
 * `time_increment`: reach diário não soma em reach semanal — deduplicação de
 * pessoas —, e é exatamente por isso que ela não pode ser derivada da série que
 * já temos. Sem `time_increment`, a resposta é uma linha por conjunto, e o custo
 * é `conjuntos / 500` páginas.
 *
 * É a diferença entre "uma chamada por conjunto" — que é como a nota de A2-S8 a
 * descreve, e que escalaria com a estrutura da conta — e "uma chamada por conta
 * até 500 conjuntos", que é o que a API de fato permite.
 */
export function reachSevenDayCost(shape: AccountShape): number {
  return Math.max(1, Math.ceil(shape.adSets / INSIGHTS_PAGE_SIZE));
}

export type BudgetVerdict = {
  /** Chamadas por ciclo, hoje. */
  current: number;
  /** Chamadas por ciclo com o reach de 7 dias. */
  projected: number;
  incremental: number;
  /** Fração do que a rajada do balde comporta num ciclo. */
  burstUtilization: number;
  fits: boolean;
  reason: string;
};

/**
 * A condição de DEC-4, avaliada.
 *
 * O critério é a **rajada**, não a taxa de reposição: um ciclo de ingest dispara
 * as chamadas em sequência, e o que decide se ele é cortado é quantos tokens o
 * balde tem no instante em que ele começa. A taxa de 5/s repõe o balde inteiro
 * em quatro segundos — se a rajada comporta, a taxa comporta com folga.
 */
export function evaluateReachBudget(input: {
  shape: AccountShape;
  burstCapacity: number;
}): BudgetVerdict {
  const current = fullSyncCost(input.shape).total;
  const incremental = reachSevenDayCost(input.shape);
  const projected = current + incremental;
  const burstUtilization = projected / input.burstCapacity;

  const fits = projected <= input.burstCapacity;

  return {
    current,
    projected,
    incremental,
    burstUtilization: Math.round(burstUtilization * 1_000) / 1_000,
    fits,
    reason: fits
      ? `${projected} chamadas por ciclo contra rajada de ${input.burstCapacity}: cabe.`
      : `${projected} chamadas por ciclo contra rajada de ${input.burstCapacity}: ` +
        'o ciclo é fatiado pelo balde e a leitura passa a esperar.',
  };
}
