import { resolveConflicts } from './conflict';
import type { PlannedAction, RecommendationPlan } from './recommendation-plan';
import type {
  RecommendationKind,
  RecommendationPriority,
} from './contracts/recommendation-catalog';

/**
 * §9.4 passo 4 — **o gate estrutural deste sprint.**
 *
 * > Deduplicar por `(ad, kind)` não evita conflito porque a ação frequentemente
 * > mira **acima** do anúncio. Dois anúncios do mesmo conjunto — um com
 * > `HIGH_CPA`, outro campeão — geram `ADJUST_AD_SET_BUDGET` em direções
 * > opostas sobre a mesma entidade, ambos válidos isoladamente.
 *
 * Aplicar os dois é aplicar o segundo: a plataforma aceita as duas escritas e o
 * orçamento final é o da última. O usuário aprovou reduzir **e** aumentar, e o
 * resultado depende da ordem de execução.
 */

const AD_SET = 'set-1';

function budgetAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    type: 'ADJUST_AD_SET_BUDGET',
    level: 'AD_SET',
    targetEntityType: 'AD_SET',
    targetEntityId: AD_SET,
    parameters: { adSetId: AD_SET, dailyBudget: 100 },
    scopeWarning: null,
    reversible: true,
    requiresRecreate: false,
    ...overrides,
  };
}

function planOf(
  adId: string,
  kind: RecommendationKind,
  overrides: {
    priority?: RecommendationPriority;
    avoidableDailyBase?: number;
    actions?: PlannedAction[];
    advisory?: boolean;
  } = {},
): RecommendationPlan {
  return {
    adId,
    kind,
    advisory: overrides.advisory ?? false,
    priority: overrides.priority ?? 'HIGH',
    title: kind,
    rationale: 'fixture',
    guidance: null,
    outOfScopeReason: null,
    blockedReason: null,
    wasteItemIds: [],
    impacts: [],
    primaryImpactType: 'SPEND_AVOIDED',
    actions: overrides.actions ?? [budgetAction()],
    evidence: { avoidableDailyBase: overrides.avoidableDailyBase ?? 100 },
    evidenceAsOf: new Date('2026-08-02T00:00:00.000Z'),
    expiresAt: new Date('2026-08-09T00:00:00.000Z'),
  };
}

describe('conflito por ALVO DE AÇÃO (§9.4 passo 4)', () => {
  it('dois ads do mesmo conjunto com ações opostas ⇒ uma DEFERRED_BY_CONFLICT', () => {
    // O gate de saída do sprint, literal.
    const reduce = planOf('ad-caro', 'REDUCE_BUDGET_HIGH_CPA', {
      priority: 'CRITICAL',
      avoidableDailyBase: 200,
    });
    const scale = planOf('ad-campeao', 'SCALE_WINNING_AD', {
      priority: 'MEDIUM',
      avoidableDailyBase: 900,
    });

    const outcome = resolveConflicts([reduce, scale]);

    expect(outcome.winners).toEqual([reduce]);
    expect(outcome.deferred).toHaveLength(1);
    expect(outcome.deferred[0].plan).toBe(scale);
    expect(outcome.deferred[0].conflictTargetId).toBe(AD_SET);
    // O conflito é **explicitado**, não só sinalizado: sem as duas intenções na
    // mensagem, "conflito" é uma palavra que o usuário não consegue usar.
    expect(outcome.deferred[0].reason).toContain('reduzir o orçamento');
    expect(outcome.deferred[0].reason).toContain('aumentar o orçamento');
  });

  it('prioridade vence, mesmo com evitável menor', () => {
    // A gravidade já pondera a evidência que sustenta o achado; o valor é o
    // segundo critério, não o primeiro.
    const outcome = resolveConflicts([
      planOf('a', 'SCALE_WINNING_AD', {
        priority: 'LOW',
        avoidableDailyBase: 5_000,
      }),
      planOf('b', 'REDUCE_BUDGET_HIGH_CPA', {
        priority: 'CRITICAL',
        avoidableDailyBase: 10,
      }),
    ]);

    expect(outcome.winners[0].adId).toBe('b');
  });

  it('empate de prioridade desempata pelo maior evitável', () => {
    const outcome = resolveConflicts([
      planOf('a', 'SCALE_WINNING_AD', {
        priority: 'HIGH',
        avoidableDailyBase: 10,
      }),
      planOf('b', 'REDUCE_BUDGET_HIGH_CPA', {
        priority: 'HIGH',
        avoidableDailyBase: 900,
      }),
    ]);

    expect(outcome.winners[0].adId).toBe('b');
  });

  it('mesma direção NÃO é conflito — as duas passam', () => {
    // Dois planos que reduzem o mesmo orçamento não se contradizem. Diferir um
    // deles esconderia um diagnóstico verdadeiro por causa de concordância.
    const outcome = resolveConflicts([
      planOf('a', 'REDUCE_BUDGET_HIGH_CPA'),
      planOf('b', 'STABILIZE_LEARNING'),
    ]);

    expect(outcome.winners).toHaveLength(2);
    expect(outcome.deferred).toEqual([]);
  });

  it('alvos diferentes não competem', () => {
    const outcome = resolveConflicts([
      planOf('a', 'REDUCE_BUDGET_HIGH_CPA'),
      planOf('b', 'SCALE_WINNING_AD', {
        actions: [budgetAction({ targetEntityId: 'set-2' })],
      }),
    ]);

    expect(outcome.winners).toHaveLength(2);
    expect(outcome.deferred).toEqual([]);
  });

  it('planos sem ação nunca disputam — consultiva não escreve', () => {
    const advisory = planOf('a', 'EXPAND_AUDIENCE', {
      advisory: true,
      actions: [],
    });

    const outcome = resolveConflicts([
      advisory,
      planOf('b', 'REDUCE_BUDGET_HIGH_CPA'),
      planOf('c', 'SCALE_WINNING_AD'),
    ]);

    expect(outcome.winners).toContain(advisory);
    expect(outcome.deferred).toHaveLength(1);
    expect(outcome.deferred[0].plan.adId).not.toBe('a');
  });

  it('a vencedora é apontada por índice — vira conflictWithId na persistência', () => {
    const outcome = resolveConflicts([
      planOf('a', 'SCALE_WINNING_AD', { priority: 'LOW' }),
      planOf('b', 'REDUCE_BUDGET_HIGH_CPA', { priority: 'CRITICAL' }),
    ]);

    const deferred = outcome.deferred[0];
    expect(outcome.winners[deferred.winnerIndex].adId).toBe('b');
  });

  it('o desempate é estável — a ordem de entrada não muda o vencedor', () => {
    // Sem estabilidade, `conflictWithId` apontaria para um vencedor diferente a
    // cada ciclo, e o job de ciclo de vida nunca reabilitaria a mesma perdedora.
    const a = planOf('a', 'SCALE_WINNING_AD', { avoidableDailyBase: 100 });
    const b = planOf('b', 'REDUCE_BUDGET_HIGH_CPA', {
      avoidableDailyBase: 100,
    });

    expect(resolveConflicts([a, b]).winners[0].adId).toBe('a');
    expect(resolveConflicts([b, a]).winners[0].adId).toBe('a');
  });
});
