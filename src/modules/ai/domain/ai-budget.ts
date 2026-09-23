/**
 * Contabilidade e teto de custo de IA (achado C9, P9).
 *
 * P9 diz que *"o custo marginal de analisar um anúncio é limitado"* e §17.1 pede
 * custo por anúncio-dia **observável, com teto**. O `inputDigest` já evita
 * recomputo; o que ele não faz é impedir que um backfill, uma troca de
 * `algoVersion` ou um bug de digest queimem o orçamento de LLM da plataforma
 * inteira numa madrugada. Digest é economia; teto é limite.
 *
 * **Estourar o teto pula o enriquecimento e mantém o produto inteiro** (P4): o
 * score é determinístico e não depende de IA, então a narrativa some e o número
 * fica. O corte é registrado como `SKIPPED_BUDGET` — chamada não feita por
 * decisão é informação de produto, e sem registro é indistinguível de bug.
 */

export type AiCallOutcome =
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED_BUDGET'
  | 'SKIPPED_DIGEST'
  /** O plano não inclui enriquecimento — chamada nunca oferecida, não cortada. */
  | 'SKIPPED_PLAN';

export type BudgetVerdict =
  | { allowed: true; remainingBase: number | null }
  | {
      allowed: false;
      reason: 'BUDGET_EXCEEDED';
      spentBase: number;
      limitBase: number;
    };

/**
 * Decide se cabe mais uma chamada no orçamento do dia.
 *
 * **Sem teto configurado, permite.** `llmDailyBudgetBase` é nulável em
 * `OrganizationAdsSettings`, e nulo significa "esta organização não declarou
 * limite" — inventar um número aqui seria decidir por ela, e o valor errado
 * cortaria o produto de quem paga por ele.
 *
 * O custo estimado da chamada entra na conta **antes** de ela acontecer: somar
 * depois deixaria a última chamada sempre passar, e num lote de mil isso é mil
 * estouros de uma chamada cada.
 */
export function evaluateBudget(input: {
  spentBase: number;
  limitBase: number | null;
  estimatedCostBase: number;
}): BudgetVerdict {
  if (input.limitBase === null) {
    return { allowed: true, remainingBase: null };
  }

  const projected = input.spentBase + input.estimatedCostBase;

  if (projected > input.limitBase) {
    return {
      allowed: false,
      reason: 'BUDGET_EXCEEDED',
      spentBase: input.spentBase,
      limitBase: input.limitBase,
    };
  }

  return {
    allowed: true,
    remainingBase: round6(input.limitBase - projected),
  };
}

/**
 * Custo estimado de uma chamada, em moeda-base.
 *
 * Estimativa **antes** e custo real **depois**: a decisão de cortar precisa
 * acontecer antes de gastar, e só o provider sabe quantos tokens de fato usou.
 * Registrar os dois é o que permite calibrar a estimativa — e uma estimativa que
 * ninguém confere vira um número decorativo.
 */
export function estimateCostBase(input: {
  inputTokens: number;
  outputTokens: number;
  inputCostPerMillionBase: number;
  outputCostPerMillionBase: number;
}): number {
  const cost =
    (input.inputTokens / 1_000_000) * input.inputCostPerMillionBase +
    (input.outputTokens / 1_000_000) * input.outputCostPerMillionBase;

  return round6(cost);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
