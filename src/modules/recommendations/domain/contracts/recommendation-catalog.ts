import type { FindingType } from 'src/modules/waste/domain/contracts/finding-catalog';
import { RECOMMENDATION_BY_FINDING } from 'src/modules/waste/domain/contracts/finding-catalog';
import type { ActionLevel } from 'src/modules/ads/domain/platform/platform-profile';

/**
 * O **catálogo público** de recomendações (§9.3) — contrato, não política.
 *
 * Quais kinds existem, que ação cada um propõe, qual impacto ele estima e qual
 * delta o outcome vai medir. `platform-actions` (A2-S7) precisa disto para saber
 * o que executar; `reports` (A2-S9) para agrupar. Nenhum dos dois pode importar
 * a `RecommendationPolicy`, que é onde o **se** mora.
 *
 * A mesma fronteira de `ad-scoring/domain/contracts/` e de
 * `waste/domain/contracts/`: o que a coisa **é** fica aqui; como ela é decidida
 * fica ao lado, e o teste de arquitetura recusa quem atravessar.
 */

export type RecommendationKind =
  | 'PAUSE_UNDERPERFORMING_AD'
  | 'REFRESH_FATIGUED_CREATIVE'
  | 'IMPROVE_WEAK_HOOK'
  | 'REPLACE_CTA'
  | 'MITIGATE_NEGATIVE_FEEDBACK'
  | 'REDUCE_BUDGET_HIGH_CPA'
  | 'STABILIZE_LEARNING'
  | 'CONSOLIDATE_OVERLAP'
  | 'EXPAND_AUDIENCE'
  | 'SCALE_WINNING_AD';

export type RecommendationStatus =
  | 'NEW'
  | 'ACKNOWLEDGED'
  | 'APPLYING'
  | 'APPLIED'
  | 'FAILED'
  | 'DISMISSED'
  | 'EXPIRED'
  | 'SUPERSEDED'
  | 'DEFERRED_BY_CONFLICT';

export type RecommendationPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AdActionType =
  | 'PAUSE_AD'
  | 'ENABLE_AD'
  | 'ARCHIVE_AD'
  | 'DUPLICATE_AD'
  | 'REPLACE_CREATIVE'
  | 'REPLACE_COPY'
  | 'REPLACE_CTA'
  | 'PAUSE_AD_SET'
  | 'ENABLE_AD_SET'
  | 'ADJUST_AD_SET_BUDGET'
  | 'PAUSE_CAMPAIGN'
  | 'ENABLE_CAMPAIGN'
  | 'ADJUST_CAMPAIGN_BUDGET';

/** §9.7 — três tipos, **nunca somados**. */
export type ImpactType = 'SAVINGS' | 'EFFICIENCY_GAIN' | 'REVENUE_UPLIFT';

/** O que o outcome de P8 mede. Casa com o enum `OutcomeDeltaKind`. */
export type OutcomeDeltaKind =
  | 'SPEND_AVOIDED'
  | 'REVENUE_DELTA'
  | 'SCORE_DELTA'
  | 'CPA_DELTA';

export const RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  'PAUSE_UNDERPERFORMING_AD',
  'REFRESH_FATIGUED_CREATIVE',
  'IMPROVE_WEAK_HOOK',
  'REPLACE_CTA',
  'MITIGATE_NEGATIVE_FEEDBACK',
  'REDUCE_BUDGET_HIGH_CPA',
  'STABILIZE_LEARNING',
  'CONSOLIDATE_OVERLAP',
  'EXPAND_AUDIENCE',
  'SCALE_WINNING_AD',
];

/**
 * Achado → recomendação, **lido do catálogo de `waste`**, não redeclarado.
 *
 * §5.3 r.4: `recommendations` é o único módulo que compõe waste + score +
 * análise criativa num plano, e é para isso que `RECOMMENDATION_BY_FINDING`
 * nasceu público em A2-S5. Uma segunda cópia do mapa aqui divergiria na primeira
 * vez que um detector mudasse de remédio — e divergiria em silêncio, porque as
 * duas continuariam compilando.
 */
export function kindForFinding(type: FindingType): RecommendationKind {
  return RECOMMENDATION_BY_FINDING[type] as RecommendationKind;
}

/**
 * A única recomendação **consultiva** da v2.0 (§9.3, §10.5).
 *
 * Expandir público está fora do escopo permanente da Allva. `EXPAND_AUDIENCE`
 * carrega `advisory: true`, `actions: []` e `outOfScopeReason` — diz o que fazer
 * na plataforma em vez de fingir uma ação ou esconder o diagnóstico. Consultivas
 * **nunca** entram nas métricas de acurácia de P8.
 */
export const ADVISORY_KINDS: readonly RecommendationKind[] = [
  'EXPAND_AUDIENCE',
];

export function isAdvisoryKind(kind: RecommendationKind): boolean {
  return ADVISORY_KINDS.includes(kind);
}

/**
 * DEC-6 — **um delta primário por recomendação, declarado na geração**.
 *
 * Uma recomendação com estimativa de `SAVINGS` e `EFFICIENCY_GAIN` produz uma
 * única medição. Sem esta regra fixa, a mesma recomendação entraria duas vezes
 * no denominador que autoriza a automação de §20-H3 — e a taxa de acerto
 * pareceria melhor ou pior conforme quantos tipos de impacto ela estimou.
 *
 * `EXPAND_AUDIENCE` tem um valor como qualquer outra porque a coluna é `NOT
 * NULL`; ele nunca é lido, porque consultiva não é medida.
 */
export const PRIMARY_IMPACT_BY_KIND: Readonly<
  Record<RecommendationKind, OutcomeDeltaKind>
> = {
  PAUSE_UNDERPERFORMING_AD: 'SPEND_AVOIDED',
  CONSOLIDATE_OVERLAP: 'SPEND_AVOIDED',
  MITIGATE_NEGATIVE_FEEDBACK: 'SPEND_AVOIDED',
  REDUCE_BUDGET_HIGH_CPA: 'CPA_DELTA',
  REPLACE_CTA: 'CPA_DELTA',
  REFRESH_FATIGUED_CREATIVE: 'SCORE_DELTA',
  IMPROVE_WEAK_HOOK: 'SCORE_DELTA',
  STABILIZE_LEARNING: 'SCORE_DELTA',
  EXPAND_AUDIENCE: 'SCORE_DELTA',
  SCALE_WINNING_AD: 'REVENUE_DELTA',
};

/** Que tipo de impacto cada kind estima (§9.7). */
export const IMPACT_TYPE_BY_KIND: Readonly<
  Record<RecommendationKind, ImpactType>
> = {
  PAUSE_UNDERPERFORMING_AD: 'SAVINGS',
  CONSOLIDATE_OVERLAP: 'SAVINGS',
  MITIGATE_NEGATIVE_FEEDBACK: 'SAVINGS',
  REDUCE_BUDGET_HIGH_CPA: 'SAVINGS',
  REFRESH_FATIGUED_CREATIVE: 'EFFICIENCY_GAIN',
  IMPROVE_WEAK_HOOK: 'EFFICIENCY_GAIN',
  REPLACE_CTA: 'EFFICIENCY_GAIN',
  STABILIZE_LEARNING: 'EFFICIENCY_GAIN',
  EXPAND_AUDIENCE: 'EFFICIENCY_GAIN',
  SCALE_WINNING_AD: 'REVENUE_UPLIFT',
};

/**
 * As alternativas de ação de cada kind, **em ordem de preferência** (§9.2).
 *
 * A ordem é dado, não `if`: a resolução percorre a lista contra
 * `PlatformProfile.hierarchy.budgetLevels` e para na primeira que a plataforma
 * suporta. Descartar é o último recurso, e quando acontece a recomendação vira
 * consultiva com `outOfScopeReason` — nunca uma recomendação vazia e silenciosa.
 */
export type ActionAlternative = {
  type: AdActionType;
  level: ActionLevel;
};

export const ACTION_PLAN_BY_KIND: Readonly<
  Record<RecommendationKind, readonly ActionAlternative[]>
> = {
  PAUSE_UNDERPERFORMING_AD: [{ type: 'PAUSE_AD', level: 'AD' }],
  MITIGATE_NEGATIVE_FEEDBACK: [{ type: 'PAUSE_AD', level: 'AD' }],
  CONSOLIDATE_OVERLAP: [{ type: 'PAUSE_AD', level: 'AD' }],
  // `PAUSE_AD` é o fallback declarado: sem criativo substituto o kind já virou
  // consultivo antes de chegar aqui (§11.4), então esta lista só é percorrida
  // quando há candidato.
  REFRESH_FATIGUED_CREATIVE: [
    { type: 'REPLACE_CREATIVE', level: 'AD' },
    { type: 'PAUSE_AD', level: 'AD' },
  ],
  IMPROVE_WEAK_HOOK: [
    { type: 'REPLACE_CREATIVE', level: 'AD' },
    { type: 'REPLACE_COPY', level: 'AD' },
  ],
  REPLACE_CTA: [{ type: 'REPLACE_CTA', level: 'AD' }],
  // O caso que §9.2 usa de exemplo: ad set primeiro, campanha quando há CBO.
  REDUCE_BUDGET_HIGH_CPA: [
    { type: 'ADJUST_AD_SET_BUDGET', level: 'AD_SET' },
    { type: 'ADJUST_CAMPAIGN_BUDGET', level: 'CAMPAIGN' },
  ],
  STABILIZE_LEARNING: [{ type: 'ADJUST_AD_SET_BUDGET', level: 'AD_SET' }],
  SCALE_WINNING_AD: [
    { type: 'ADJUST_AD_SET_BUDGET', level: 'AD_SET' },
    { type: 'ADJUST_CAMPAIGN_BUDGET', level: 'CAMPAIGN' },
  ],
  // Consultiva: nenhuma ação, por decisão de escopo e não por falta de suporte.
  EXPAND_AUDIENCE: [],
};

/**
 * A direção em que a ação move orçamento.
 *
 * É o que torna o conflito de §9.4 passo 4 **detectável**: duas ações de tipo
 * idêntico sobre a mesma entidade só se contradizem quando apontam para lados
 * opostos. Sem a direção, `ADJUST_AD_SET_BUDGET` de dois anúncios do mesmo
 * conjunto pareceria a mesma intenção repetida.
 */
export type BudgetDirection = 'INCREASE' | 'DECREASE' | 'NONE';

export const BUDGET_DIRECTION_BY_KIND: Readonly<
  Record<RecommendationKind, BudgetDirection>
> = {
  SCALE_WINNING_AD: 'INCREASE',
  REDUCE_BUDGET_HIGH_CPA: 'DECREASE',
  STABILIZE_LEARNING: 'DECREASE',
  PAUSE_UNDERPERFORMING_AD: 'NONE',
  MITIGATE_NEGATIVE_FEEDBACK: 'NONE',
  CONSOLIDATE_OVERLAP: 'NONE',
  REFRESH_FATIGUED_CREATIVE: 'NONE',
  IMPROVE_WEAK_HOOK: 'NONE',
  REPLACE_CTA: 'NONE',
  EXPAND_AUDIENCE: 'NONE',
};

/**
 * Ações que recriam a entidade na plataforma e reiniciam o aprendizado.
 *
 * A lista global saiu em A2-S8. Ela era "o padrão conservador, que avisa a mais
 * em vez de a menos" — e isso não era conservador, era errado nos dois sentidos:
 * dizia que `REPLACE_CREATIVE` recria na Meta (não recria: o `ad_id` permanece)
 * e que `DUPLICATE_AD` recria em qualquer lugar (não recria: cria um irmão, e o
 * original segue veiculando). Uma lista sem plataforma só pode acertar uma das
 * respostas quando as plataformas discordam — e elas discordam justamente aqui.
 *
 * A pergunta agora é respondida por `requiresRecreate(platform, type)` em
 * `ads/domain/platform/platform-profiles`, que é onde o comportamento de cada
 * plataforma já morava. O **impacto** — reinício de aprendizado, perda de prova
 * social — é outra pergunta, e sai de `actionImpactFor`.
 */
export { requiresRecreate } from 'src/modules/ads/domain/platform/platform-profiles';
