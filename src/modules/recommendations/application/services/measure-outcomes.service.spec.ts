import { MeasureOutcomesService } from './measure-outcomes.service';
import type { PendingOutcome } from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';

/**
 * O job de C4 — **o passo 6 da Definition of Done** (§17.3).
 *
 * O que este teste protege não é a aritmética (essa vive em
 * `outcome-measurement.spec.ts`): é a fronteira entre "não houve efeito" e "não
 * observamos nada", e a fixação da taxa de câmbio de M4. As duas, erradas, são
 * silenciosas — o produto continua produzindo números, só que sobre outra coisa.
 */

function pending(overrides: Partial<PendingOutcome> = {}): PendingOutcome {
  return {
    id: 'outcome-1',
    recommendationId: 'reco-1',
    organizationId: 'org-1',
    adId: 'ad-1',
    lineageId: 'lin-1',
    appliedAt: new Date('2026-07-01T00:00:00Z'),
    windowDays: 14,
    restatementWindowDays: 14,
    currency: 'USD',
    baseCurrency: 'BRL',
    fxRateFixed: 5,
    preSpendBase: 1_000,
    preRevenueBase: 0,
    preConversions: 0,
    preAiScore: 40,
    observedDeltaKind: 'SPEND_AVOIDED',
    engineVersion: 'reco-v2.0.0',
    ...overrides,
  };
}

function postWindow(overrides = {}) {
  return {
    spend: 0,
    revenue: 0,
    conversions: 0,
    aiScore: 40,
    observedDays: 14,
    seriesDiscontinuity: null,
    lineageAdCount: 1,
    externalStatusChange: false,
    concurrentActions: 0,
    lastObservedAt: new Date('2026-07-15T00:00:00Z'),
    ...overrides,
  };
}

function build(input: { pending?: PendingOutcome[]; post?: object } = {}) {
  const outcomes = {
    listPendingMeasurement: jest
      .fn()
      .mockResolvedValue(input.pending ?? [pending()]),
    buildPostWindow: jest.fn().mockResolvedValue(postWindow(input.post ?? {})),
    recordMeasurement: jest.fn().mockResolvedValue(undefined),
    abandon: jest.fn().mockResolvedValue(undefined),
    findUnmeasuredApplied: jest.fn().mockResolvedValue([]),
  };

  const events = { emitFrom: jest.fn() };

  return {
    service: new MeasureOutcomesService(outcomes as never, events as never),
    outcomes,
    events,
  };
}

const ctx = { correlationId: 'corr-1', causationId: null };
const now = new Date('2026-08-01T00:00:00Z');

const run = (h: ReturnType<typeof build>) =>
  h.service.execute({ organizationId: 'org-1', ctx, now });

describe('a medição fecha a janela pós sobre a linhagem', () => {
  it('mede, grava com a versão e emite o evento', async () => {
    const h = build();

    const result = await run(h);

    expect(result).toMatchObject({
      evaluated: 1,
      measured: 1,
      abandoned: 0,
      unmeasurable: [],
    });
    expect(h.outcomes.buildPostWindow).toHaveBeenCalledWith(
      expect.objectContaining({ lineageId: 'lin-1' }),
    );
    expect(h.outcomes.recordMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomeId: 'outcome-1',
        verdict: 'IMPROVED',
        measurementVersion: expect.stringMatching(/^measure-/),
      }),
    );
    expect(h.events.emitFrom).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'recommendation.outcome.measured',
      expect.objectContaining({ lineageId: 'lin-1', verdict: 'IMPROVED' }),
    );
  });

  /**
   * M4 — as duas janelas pela **mesma** taxa, a de `appliedAt`.
   *
   * A janela pós é lida em moeda nativa e convertida aqui. Somar `spendBase`,
   * que carrega a taxa do dia de cada linha, faria a variação cambial entre as
   * duas janelas entrar no `observedDelta` como se fosse efeito da recomendação.
   */
  it('converte o pós pela taxa fixada, não pela taxa de cada dia', async () => {
    const h = build({ post: { spend: 100 } });

    await run(h);

    // 100 USD × 5 = 500 BRL, contra um pré de 1.000 BRL: delta de 500.
    expect(h.outcomes.recordMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({ postSpendBase: 500, observedDelta: 500 }),
    );
  });

  it('o evento sai mesmo quando o veredito é INCONCLUSIVE', async () => {
    // A calibração de P8 precisa saber quantas não concluíram: uma taxa de
    // acerto calculada só sobre as conclusivas é uma taxa sobre a amostra que o
    // próprio sistema escolheu.
    const h = build({ post: { observedDays: 3 } });

    const result = await run(h);

    expect(result).toMatchObject({ measured: 1, inconclusive: 1 });
    expect(h.events.emitFrom).toHaveBeenCalledWith(
      expect.anything(),
      'recommendation.outcome.measured',
      expect.objectContaining({ verdict: 'INCONCLUSIVE', observedDelta: 0 }),
    );
  });
});

describe('P8 é verificado a cada ciclo, não só em teste', () => {
  /**
   * `APPLIED` **sem linha nenhuma** de outcome é um buraco permanente: o "pré"
   * era um fato do instante da aplicação, e reconstruí-lo agora leria dado já
   * re-declarado. A transação de `markApplied` o torna impossível por
   * construção — e "impossível por construção" é afirmação sobre o código de
   * hoje, enquanto P8 é afirmação sobre o dataset de sempre.
   */
  it('aplicada sem outcome aparece no resultado do ciclo', async () => {
    const h = build();
    h.outcomes.findUnmeasuredApplied.mockResolvedValue(['reco-orfa']);

    const result = await run(h);

    expect(result.unmeasurable).toEqual(['reco-orfa']);
  });
});

describe('cegueira não é economia', () => {
  /**
   * A distinção que o sprint inteiro protege: um anúncio pausado gasta zero **e
   * é observado** gastando zero; um anúncio cuja conta ficou inalcançável não
   * produz linha nenhuma. Tratar os dois igual creditaria à recomendação uma
   * economia integral produzida pela própria falta de dado.
   */
  it('janela sem nenhum dia observado, muito depois do prazo, vira ABANDONED', async () => {
    const h = build({
      pending: [pending({ appliedAt: new Date('2026-01-01T00:00:00Z') })],
      post: { observedDays: 0, lastObservedAt: null },
    });

    const result = await run(h);

    expect(result).toMatchObject({ abandoned: 1, measured: 0 });
    expect(h.outcomes.abandon).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeId: 'outcome-1' }),
    );
    expect(h.outcomes.recordMeasurement).not.toHaveBeenCalled();
  });

  it('janela sem dado ainda dentro do horizonte NÃO é abandonada', async () => {
    // Pode ser integração fora do ar por uma noite. Desistir aqui perderia um
    // outcome que o ciclo de amanhã mediria sem problema.
    const h = build({ post: { observedDays: 0, lastObservedAt: null } });

    const result = await run(h);

    expect(h.outcomes.abandon).not.toHaveBeenCalled();
    expect(result.measured).toBe(1);
  });
});
