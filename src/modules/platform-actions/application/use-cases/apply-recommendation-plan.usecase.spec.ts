import { ApplyRecommendationPlanUseCase } from './apply-recommendation-plan.usecase';
import type { RecommendationView } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * `POST /recommendations/{id}/apply` com escrita real — §9.5 passos 1 a 4.
 *
 * O gate que este teste protege é o de P5: **não há caminho de escrita novo**.
 * Aplicar um plano passa pelo mesmo `ExecuteActionUseCase` da escrita
 * individual, com a mesma cadeia de guardas — um caminho paralelo seria, por
 * construção, o que não as tem.
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
    status: 'NEW',
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
    wasteItems: [],
    actions: [
      {
        id: 'action-1',
        type: 'PAUSE_AD',
        level: 'AD',
        parameters: { schemaVersion: 1, adId: 'ad-1' },
        targetEntityType: 'AD',
        targetEntityId: 'ad-1',
        scopeWarning: null,
        reversible: true,
        requiresRecreate: false,
      },
    ],
    dataMaturity: 'MATURE',
    evidence: {},
    evidenceAsOf: new Date(),
    expiresAt: null,
    engineVersion: 'reco-v2.0.0',
    ...overrides,
  };
}

function build(
  input: { recommendation?: RecommendationView; began?: boolean } = {},
) {
  const dryRunApply = {
    execute: jest.fn().mockResolvedValue({ data: { dryRun: true }, meta: {} }),
    revalidate: jest.fn().mockResolvedValue(input.recommendation ?? view()),
  };

  const application = {
    begin: jest.fn().mockResolvedValue(input.began ?? true),
    abort: jest.fn().mockResolvedValue(undefined),
  };

  const executor = {
    run: jest.fn().mockResolvedValue([
      {
        actionId: 'action-1',
        type: 'PAUSE_AD',
        accepted: true,
        executionId: 'exec-1',
        refusal: null,
      },
    ]),
  };

  return {
    useCase: new ApplyRecommendationPlanUseCase(
      dryRunApply as never,
      application as never,
      executor as never,
    ),
    dryRunApply,
    application,
    executor,
  };
}

const run = (h: ReturnType<typeof build>, dryRun?: boolean) =>
  h.useCase.execute({
    organizationId: 'org-1',
    accountId: 'user-1',
    recommendationId: 'reco-1',
    body: dryRun === undefined ? {} : { dryRun },
    correlationId: 'corr-1',
    ipAddress: null,
    userAgent: null,
  });

describe('dry-run é o default, e pedir escrita real é explícito', () => {
  it('sem `dryRun` no corpo, delega ao relatório de simulação', async () => {
    // Assumir escrita real por omissão faria um cliente desatualizado mover
    // dinheiro por não ter mandado um campo.
    const h = build();

    await run(h);

    expect(h.dryRunApply.execute).toHaveBeenCalled();
    expect(h.application.begin).not.toHaveBeenCalled();
  });

  it('`dryRun: true` também simula', async () => {
    const h = build();

    await run(h, true);

    expect(h.executor.run).not.toHaveBeenCalled();
  });
});

describe('escrita real — §9.5 passos 1 a 4', () => {
  it('revalida a premissa, põe em voo e executa o plano', async () => {
    const h = build();

    const result = await run(h, false);

    // A ordem importa: a premissa antes do estado em voo, o estado em voo antes
    // da primeira escrita.
    expect(h.dryRunApply.revalidate).toHaveBeenCalled();
    expect(h.application.begin).toHaveBeenCalled();
    expect(h.executor.run).toHaveBeenCalledWith(
      expect.objectContaining({ adId: 'ad-1', recommendationId: 'reco-1' }),
      expect.arrayContaining([expect.objectContaining({ id: 'action-1' })]),
    );
    expect(result.data).toMatchObject({ dryRun: false, status: 'APPLYING' });
  });

  /**
   * `begin` devolve `false` quando a recomendação já saiu de `NEW`. Recusar
   * aqui é o que impede dois cliques de dispararem o mesmo plano — I2 protege o
   * **alvo**, e um plano com dois alvos passaria por ela.
   */
  it('segundo clique é recusado antes de qualquer escrita', async () => {
    const h = build({ began: false });

    await expect(run(h, false)).rejects.toMatchObject({
      code: 'RECOMMENDATION_NOT_APPLICABLE',
    });
    expect(h.executor.run).not.toHaveBeenCalled();
  });

  it('consultiva sem ação é recusada com o motivo', async () => {
    const h = build({ recommendation: view({ actions: [] }) });

    await expect(run(h, false)).rejects.toBeInstanceOf(DomainError);
    expect(h.application.begin).not.toHaveBeenCalled();
  });

  /**
   * Sem isto a recomendação ficaria `APPLYING` sem nenhuma execução para
   * tirá-la de lá: a liquidação só corre quando uma execução assenta, e não há
   * nenhuma. §16.16 — nenhum status não terminal sem caminho de saída.
   */
  it('nenhuma ação aceita ⇒ o plano falha na hora, com o motivo da primeira', async () => {
    const h = build();
    h.executor.run.mockResolvedValue([
      {
        actionId: 'action-1',
        type: 'PAUSE_AD',
        accepted: false,
        executionId: null,
        refusal: { code: 'KILL_SWITCH', message: 'As ações estão desligadas.' },
      },
    ]);

    const result = await run(h, false);

    expect(h.application.abort).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'As ações estão desligadas.' }),
    );
    expect(result.data).toMatchObject({ status: 'FAILED' });
  });
});
