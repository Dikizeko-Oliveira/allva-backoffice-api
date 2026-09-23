import { RecommendationSettlementService } from './recommendation-settlement.service';
import type { RecommendationPlanStatus } from 'src/modules/platform-actions/domain/ports/action-executions.repository';

/**
 * §9.5 passo 5 — **quando um plano assentou**.
 *
 * Cada execução termina no seu próprio job, e a última a terminar é a única que
 * sabe que é a última — porque conta as outras. Errar essa contagem tem duas
 * formas, e as duas são caras: declarar aplicada uma recomendação com escrita em
 * voo, ou deixá-la `APPLYING` para sempre porque ninguém somou direito.
 */

function plan(
  overrides: Partial<RecommendationPlanStatus> = {},
): RecommendationPlanStatus {
  return {
    plannedActions: 2,
    pending: 0,
    succeeded: 2,
    failed: 0,
    executionIds: ['exec-1', 'exec-2'],
    lastSettledExecutionId: 'exec-2',
    settledAt: new Date('2026-08-01T12:00:00Z'),
    ...overrides,
  };
}

function build(status: RecommendationPlanStatus = plan()) {
  const executions = {
    planStatusFor: jest.fn().mockResolvedValue(status),
  };
  const application = {
    settle: jest.fn().mockResolvedValue({ kind: 'APPLIED', outcomeId: 'o-1' }),
  };

  return {
    service: new RecommendationSettlementService(
      executions as never,
      application as never,
    ),
    executions,
    application,
  };
}

const notify = (h: ReturnType<typeof build>) =>
  h.service.onExecutionSettled({
    organizationId: 'org-1',
    recommendationId: 'reco-1',
    requestedByAccountId: 'user-1',
    ctx: { correlationId: 'corr-1', causationId: null },
  });

describe('o plano só assenta quando nenhuma escrita está em voo', () => {
  it('todas as ações bem-sucedidas ⇒ liquida como aplicada', async () => {
    const h = build();

    await notify(h);

    expect(h.application.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        allSucceeded: true,
        executionIds: ['exec-1', 'exec-2'],
        lastSettledExecutionId: 'exec-2',
      }),
    );
  });

  it('com execução pendente, não liquida nada', async () => {
    // A recomendação continua `APPLYING`, que é o estado honesto: declarar
    // aplicada com uma ação pendente prometeria um efeito que a plataforma
    // ainda pode recusar.
    const h = build(plan({ pending: 1, succeeded: 1 }));

    await notify(h);

    expect(h.application.settle).not.toHaveBeenCalled();
  });

  it('sem nenhuma execução real ainda, sai sem fazer nada', async () => {
    // A leitura é uma foto, e a foto pode ser de um instante intermediário —
    // o primeiro `settle` chegando antes de a última ação ser enfileirada. A
    // execução seguinte reavalia com o plano completo.
    const h = build(
      plan({ executionIds: [], succeeded: 0, lastSettledExecutionId: null }),
    );

    await notify(h);

    expect(h.application.settle).not.toHaveBeenCalled();
  });
});

describe('plano parcialmente executado não é uma aplicação', () => {
  it('uma ação recusada pela plataforma reprova o plano inteiro', async () => {
    const h = build(plan({ succeeded: 1, failed: 1 }));

    await notify(h);

    expect(h.application.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        allSucceeded: false,
        failureDetail: expect.stringContaining('1 ação(ões)'),
      }),
    );
  });

  /**
   * O caso que só a contagem de `plannedActions` pega: uma ação recusada por
   * guarda **antes** de enfileirar não gera execução nenhuma. Contar só
   * execuções faria um plano de três com uma recusada parecer um plano de duas
   * — inteiramente bem-sucedido.
   */
  it('ação que nunca virou execução também reprova', async () => {
    const h = build(
      plan({
        plannedActions: 3,
        succeeded: 2,
        executionIds: ['exec-1', 'exec-2'],
      }),
    );

    await notify(h);

    expect(h.application.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        allSucceeded: false,
        failureDetail: expect.stringContaining('não chegaram a ser'),
      }),
    );
  });
});
