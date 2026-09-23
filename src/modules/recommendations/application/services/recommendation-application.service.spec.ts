import { RecommendationApplicationService } from './recommendation-application.service';
import type { RecommendationView } from 'src/modules/recommendations/domain/ports/recommendations.repository';

/**
 * Os passos 5, 6, 8 e 9 de §9.5 — **o que fecha o ciclo de P8**.
 *
 * Antes de A2-S9 nada nesta cadeia existia: `capturePreWindow` não tinha
 * chamador, nenhuma recomendação chegava a `APPLIED`, e o dataset de acurácia
 * nasceria vazio por construção. O que este teste protege é que a transição e o
 * outcome andam **juntos** e **uma vez só**.
 */

function view(overrides: Partial<RecommendationView> = {}): RecommendationView {
  return {
    id: 'reco-1',
    ad: {
      id: 'ad-1',
      lineageId: 'lin-1',
      name: 'Anúncio',
      platform: 'META',
      externalAdId: 'ext-1',
      observedStatus: 'ACTIVE',
      campaign: { id: 'camp-1', name: 'Campanha' },
      adSet: { id: 'set-1', name: 'Conjunto' },
    },
    kind: 'PAUSE_UNDERPERFORMING_AD',
    advisory: false,
    outOfScopeReason: null,
    title: 'Pausar',
    rationale: 'fixture',
    guidance: null,
    priority: 'HIGH',
    status: 'APPLYING',
    blockedReason: null,
    conflictWithId: null,
    impacts: [
      {
        type: 'SAVINGS',
        estimated: {
          value: 900,
          currency: 'BRL',
          valueBase: 900,
          baseCurrency: 'BRL',
        },
        horizonDays: 14,
        confidence: 0.7,
        realized: null,
      },
    ],
    primaryImpactType: 'SPEND_AVOIDED',
    baseCurrency: 'BRL',
    wasteItems: [
      { id: 'item-1', type: 'ZERO_CONVERSIONS', open: true },
      { id: 'item-2', type: 'LOW_ROAS', open: true },
      // Já resolvido por outro caminho: não volta a ser resolvido.
      { id: 'item-3', type: 'LOW_CTR', open: false },
    ],
    actions: [],
    dataMaturity: 'MATURE',
    evidence: {},
    evidenceAsOf: new Date(),
    expiresAt: null,
    engineVersion: 'reco-v2.0.0',
    ...overrides,
  };
}

function build(input: { applied?: boolean; baseline?: object | null } = {}) {
  const recommendations = {
    findOne: jest.fn().mockResolvedValue(view()),
    markApplying: jest.fn().mockResolvedValue(true),
    markApplyFailed: jest.fn().mockResolvedValue(true),
    markApplied: jest.fn().mockResolvedValue({
      applied: input.applied ?? true,
      outcomeId: input.applied === false ? null : 'outcome-1',
    }),
  };

  const outcomes = {
    buildPreWindow: jest.fn().mockResolvedValue(
      input.baseline === undefined
        ? {
            recommendationId: 'reco-1',
            adId: 'ad-1',
            lineageId: 'lin-1',
            organizationId: 'org-1',
            appliedAt: new Date(),
            windowDays: 14,
            currency: 'BRL',
            baseCurrency: 'BRL',
            fxRateFixed: 1,
            preSpendBase: 900,
            preRevenueBase: 0,
            preConversions: 0,
            preAiScore: 32,
          }
        : input.baseline,
    ),
  };

  const wasteItems = {
    resolveMany: jest.fn().mockResolvedValue(2),
    recomputeDenormalization: jest.fn().mockResolvedValue(undefined),
  };

  const events = { emitFrom: jest.fn() };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new RecommendationApplicationService(
      recommendations as never,
      outcomes as never,
      wasteItems as never,
      events as never,
      audit as never,
    ),
    recommendations,
    outcomes,
    wasteItems,
    events,
    audit,
  };
}

const settledAt = new Date('2026-08-01T12:00:00Z');

const settle = (h: ReturnType<typeof build>, allSucceeded = true) =>
  h.service.settle({
    organizationId: 'org-1',
    recommendationId: 'reco-1',
    allSucceeded,
    failureDetail: allSucceeded ? null : 'A plataforma recusou.',
    executionIds: ['exec-1'],
    lastSettledExecutionId: 'exec-1',
    settledAt,
    actorId: 'user-1',
    ctx: { correlationId: 'corr-1', causationId: null },
  });

describe('todas SUCCEEDED ⇒ APPLIED, com o outcome na mesma transação', () => {
  it('grava a transição e o snapshot pré num passo só', async () => {
    const h = build();

    const result = await settle(h);

    expect(result).toMatchObject({ kind: 'APPLIED', outcomeId: 'outcome-1' });
    expect(h.recommendations.markApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        appliedAt: settledAt,
        outcome: expect.objectContaining({
          preSpendBase: 900,
          // DEC-6 — o delta primário vem do kind, não de escolha na medição.
          observedDeltaKind: 'SPEND_AVOIDED',
          engineVersion: 'reco-v2.0.0',
        }),
      }),
    );
  });

  /**
   * §9.5 passo 8 — resolve **todos** os achados vinculados, não o que originou.
   *
   * Uma recomendação nasce de N achados. Pausar o anúncio resolve o CPA alto **e**
   * a fadiga: fechar um e deixar os outros abertos faria a tela continuar
   * cobrando ação sobre um anúncio que já não veicula.
   */
  it('resolve os achados abertos como RESOLVED_BY_ACTION e recalcula a denormalização', async () => {
    const h = build();

    await settle(h);

    expect(h.wasteItems.resolveMany).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'item-1',
        kind: 'RESOLVED_BY_ACTION',
        resolvedByActionExecutionId: 'exec-1',
      }),
      expect.objectContaining({ id: 'item-2' }),
    ]);
    // `item-3` já estava fechado: reabri-lo para fechar de novo emitiria um
    // `waste.resolved` por algo que ninguém acabou de resolver.
    expect(h.wasteItems.resolveMany.mock.calls[0][0]).toHaveLength(2);
    expect(h.wasteItems.recomputeDenormalization).toHaveBeenCalledWith(
      ['ad-1'],
      settledAt,
    );
  });

  it('emite recommendation.applied e um waste.resolved por item', async () => {
    const h = build();

    await settle(h);

    const emitted = h.events.emitFrom.mock.calls.map((call) => call[1]);
    expect(emitted).toEqual([
      'waste.resolved',
      'waste.resolved',
      'recommendation.applied',
    ]);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ad.recommendation.applied' }),
    );
  });

  /**
   * A idempotência que o passo 6 exige: um worker reexecutado, um retry de fila
   * ou duas execuções assentando no mesmo milissegundo produzem **uma**
   * aplicação e **um** outcome. A guarda é a transição condicionada a
   * `APPLYING`, no banco — não uma checagem prévia aqui.
   */
  it('a segunda chamada não cria segundo outcome nem reemite nada', async () => {
    const h = build({ applied: false });

    const result = await settle(h);

    expect(result).toEqual({ kind: 'ALREADY_SETTLED' });
    expect(h.wasteItems.resolveMany).not.toHaveBeenCalled();
    expect(h.events.emitFrom).not.toHaveBeenCalled();
  });
});

describe('alguma falhou ⇒ FAILED, e nada de outcome', () => {
  it('grava o motivo e não cria linha de medição', async () => {
    const h = build();

    const result = await settle(h, false);

    expect(result).toEqual({ kind: 'FAILED' });
    expect(h.recommendations.markApplyFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'A plataforma recusou.' }),
    );
    expect(h.recommendations.markApplied).not.toHaveBeenCalled();
  });

  it('anúncio que sumiu entre a escrita e o registro também é FAILED', async () => {
    // Sem isto a recomendação ficaria `APPLYING` para sempre — §16.16 proíbe
    // status não terminal sem caminho de saída.
    const h = build({ baseline: null });

    const result = await settle(h);

    expect(result).toEqual({ kind: 'FAILED' });
    expect(h.recommendations.markApplyFailed).toHaveBeenCalled();
  });
});

describe('a falha ao resolver achados não desfaz a aplicação', () => {
  it('a aplicação permanece; o auto-resolve do ciclo seguinte é a rede', async () => {
    const h = build();
    h.wasteItems.resolveMany.mockRejectedValue(new Error('deadlock'));

    const result = await settle(h);

    expect(result).toMatchObject({ kind: 'APPLIED', resolvedWasteItems: 0 });
    expect(h.events.emitFrom).toHaveBeenCalledWith(
      expect.anything(),
      'recommendation.applied',
      expect.anything(),
    );
  });
});
