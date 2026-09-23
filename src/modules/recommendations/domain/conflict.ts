import {
  BUDGET_DIRECTION_BY_KIND,
  type BudgetDirection,
} from './contracts/recommendation-catalog';
import type { RecommendationPlan } from './recommendation-plan';

/**
 * Resolução de conflito **por alvo de ação** (§9.4 passo 4).
 *
 * > Deduplicar por `(ad, kind)` não evita conflito porque a ação frequentemente
 * > mira **acima** do anúncio. Dois anúncios do mesmo conjunto — um com
 * > `HIGH_CPA`, outro campeão — geram `ADJUST_AD_SET_BUDGET` em direções
 * > opostas sobre a mesma entidade, ambos válidos isoladamente, ambos oferecidos
 * > ao usuário.
 *
 * Aplicar os dois é aplicar o segundo: a plataforma aceita as duas escritas e o
 * orçamento final é o da última. O usuário aprovou reduzir e aumentar, e o
 * resultado é aleatório na ordem de execução.
 *
 * A perdedora vira `DEFERRED_BY_CONFLICT` com o conflito **explicitado** — não
 * descartada. §9.4 passo 8 é quem a traz de volta quando o conflito cessa, e sem
 * ele o estado seria terminal por acidente.
 */

export type ConflictOutcome = {
  /** Planos que seguem para persistência como `NEW`. */
  winners: RecommendationPlan[];
  /** Planos diferidos, com o alvo disputado e o vencedor declarados. */
  deferred: Array<{
    plan: RecommendationPlan;
    conflictTargetType: string;
    conflictTargetId: string;
    /** Índice do vencedor em `winners` — vira `conflictWithId` na persistência. */
    winnerIndex: number;
    reason: string;
  }>;
};

type Candidate = {
  plan: RecommendationPlan;
  targetKey: string;
  targetType: string;
  targetId: string;
  direction: BudgetDirection;
};

/**
 * Agrupa **todos** os planos por `(targetEntityType, targetEntityId)` e resolve.
 *
 * Planos consultivos e bloqueados não entram na disputa: eles não têm ação, e
 * portanto não há escrita para colidir. Diferi-los esconderia um diagnóstico
 * verdadeiro por causa de um conflito que eles não causam.
 */
export function resolveConflicts(plans: RecommendationPlan[]): ConflictOutcome {
  const actionable: Candidate[] = [];
  const winners: RecommendationPlan[] = [];

  for (const plan of plans) {
    const action = plan.actions[0];
    if (!action) {
      winners.push(plan);
      continue;
    }

    actionable.push({
      plan,
      targetKey: `${action.targetEntityType}:${action.targetEntityId}`,
      targetType: action.targetEntityType,
      targetId: action.targetEntityId,
      direction: BUDGET_DIRECTION_BY_KIND[plan.kind],
    });
  }

  const byTarget = new Map<string, Candidate[]>();
  for (const candidate of actionable) {
    const bucket = byTarget.get(candidate.targetKey) ?? [];
    bucket.push(candidate);
    byTarget.set(candidate.targetKey, bucket);
  }

  const deferred: ConflictOutcome['deferred'] = [];

  for (const group of byTarget.values()) {
    if (group.length === 1) {
      winners.push(group[0].plan);
      continue;
    }

    // Só há conflito quando as direções **divergem**. Dois planos que reduzem o
    // mesmo orçamento não se contradizem — o segundo é redundante, e a
    // deduplicação por `(ad, kind)` no índice parcial já cuida disso.
    const directions = new Set(
      group.map((candidate) => candidate.direction).filter((d) => d !== 'NONE'),
    );

    if (directions.size < 2) {
      for (const candidate of group) winners.push(candidate.plan);
      continue;
    }

    const ranked = [...group].sort(compareCandidates);
    const [winner, ...losers] = ranked;
    const winnerIndex = winners.push(winner.plan) - 1;

    for (const loser of losers) {
      deferred.push({
        plan: loser.plan,
        conflictTargetType: loser.targetType,
        conflictTargetId: loser.targetId,
        winnerIndex,
        reason:
          `Conflito no mesmo alvo (${loser.targetType} ${loser.targetId}): ` +
          `"${winner.plan.kind}" quer ${describe(winner.direction)} e ` +
          `"${loser.plan.kind}" quer ${describe(loser.direction)}. ` +
          'A de maior prioridade e maior valor evitável prevalece; esta volta ' +
          'quando o conflito cessar.',
      });
    }
  }

  return { winners, deferred };
}

/**
 * Maior prioridade primeiro; empate desfeito pelo maior evitável diário.
 *
 * O segundo critério é o de §9.4, e a ordem entre eles importa: prioridade
 * carrega a gravidade do problema, e o evitável carrega o tamanho. Um achado
 * `CRITICAL` de R$ 40/dia vence um `MEDIUM` de R$ 900/dia porque a gravidade já
 * pondera a evidência que o sustenta.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const priority = rankOf(b.plan.priority) - rankOf(a.plan.priority);
  if (priority !== 0) return priority;

  const value = avoidableOf(b.plan) - avoidableOf(a.plan);
  if (value !== 0) return value;

  // Desempate estável: sem ele, dois planos idênticos trocariam de lugar entre
  // execuções e o `conflictWithId` apontaria para um vencedor diferente a cada
  // ciclo.
  return a.plan.adId < b.plan.adId ? -1 : a.plan.adId > b.plan.adId ? 1 : 0;
}

function avoidableOf(plan: RecommendationPlan): number {
  const value = plan.evidence.avoidableDailyBase;
  return typeof value === 'number' ? value : 0;
}

function rankOf(priority: RecommendationPlan['priority']): number {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(priority);
}

function describe(direction: BudgetDirection): string {
  if (direction === 'INCREASE') return 'aumentar o orçamento';
  if (direction === 'DECREASE') return 'reduzir o orçamento';
  return 'agir sobre a mesma entidade';
}
