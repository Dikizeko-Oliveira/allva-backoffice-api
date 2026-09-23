import { NotFoundException } from '@nestjs/common';
import { ApplyRecommendationUseCase } from './apply-recommendation.usecase';
import type { EnvService } from 'src/shared/infrastructure/config/env.service';
import type { PremiseState } from 'src/modules/recommendations/domain/premise';
import type { RecommendationView } from 'src/modules/recommendations/domain/ports/recommendations.repository';

/**
 * `POST /{id}/apply` — **o gate de premissa vencida do sprint**:
 *
 * > "recomendação com premissa vencida ⇒ 409 tipado, expirada na hora, motivo
 * > visível."
 *
 * O teste de domínio prova que a regra decide certo; este prova que a **escrita**
 * acontece. Sem ela a recomendação continuaria `NEW` e o clique seguinte
 * ofereceria de novo a mesma decisão sobre o mesmo mundo que já não existe.
 */

function view(overrides: Partial<RecommendationView> = {}): RecommendationView {
  return {
    id: 'reco-1',
    ad: {
      id: 'ad-1',
      lineageId: 'ad-1',
      name: 'Anúncio',
      platform: 'META',
      externalAdId: 'ext-1',
      observedStatus: 'ACTIVE',
      campaign: { id: 'campaign-1', name: 'Campanha' },
      adSet: { id: 'set-1', name: 'Conjunto' },
    },
    kind: 'PAUSE_UNDERPERFORMING_AD',
    advisory: false,
    outOfScopeReason: null,
    title: 'Pausar anúncio sem retorno',
    rationale: 'fixture',
    guidance: null,
    priority: 'CRITICAL',
    status: 'NEW',
    blockedReason: null,
    conflictWithId: null,
    impacts: [
      {
        type: 'SAVINGS',
        estimated: {
          value: 1_400,
          currency: 'BRL',
          valueBase: 1_400,
          baseCurrency: 'BRL',
        },
        horizonDays: 14,
        confidence: 0.8,
        realized: null,
      },
    ],
    primaryImpactType: 'SPEND_AVOIDED',
    baseCurrency: 'BRL',
    wasteItems: [{ id: 'item-1', type: 'ZERO_CONVERSIONS', open: true }],
    actions: [
      {
        id: 'action-1',
        type: 'PAUSE_AD',
        level: 'AD',
        parameters: { adId: 'ad-1', schemaVersion: 1 },
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
    expiresAt: new Date(Date.now() + 86_400_000),
    engineVersion: 'reco-v2.0.0',
    ...overrides,
  };
}

function premise(overrides: Partial<PremiseState> = {}): PremiseState {
  return {
    status: 'NEW',
    expiresAt: new Date(Date.now() + 86_400_000),
    suppressed: false,
    linkedWasteItems: 1,
    openWasteItems: 1,
    evidenceAsOf: new Date(),
    evidenceMaxAgeDays: 3,
    dataMaturity: 'MATURE',
    requiresMature: true,
    adArchived: false,
    adObservable: true,
    integrationReachable: true,
    capabilitySupported: true,
    consentGranted: true,
    killSwitchOn: false,
    writeInFlightId: null,
    ...overrides,
  };
}

function build(
  input: {
    recommendation?: RecommendationView | null;
    premise?: PremiseState | null;
  } = {},
) {
  const marked: Array<{ status: string; reason?: string | null }> = [];

  const recommendations = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        input.recommendation === undefined ? view() : input.recommendation,
      ),
    premiseStateFor: jest
      .fn()
      .mockResolvedValue(
        input.premise === undefined ? premise() : input.premise,
      ),
    markStatus: jest.fn(
      async (call: { status: string; reason?: string | null }) => {
        marked.push(call);
        return true;
      },
    ),
  };

  const outcomes = {
    buildPreWindow: jest.fn().mockResolvedValue({
      recommendationId: 'reco-1',
      adId: 'ad-1',
      lineageId: 'ad-1',
      organizationId: 'org-1',
      appliedAt: new Date(),
      windowDays: 14,
      currency: 'BRL',
      baseCurrency: 'BRL',
      fxRateFixed: 1,
      preSpendBase: 1_400,
      preRevenueBase: 0,
      preConversions: 0,
      preAiScore: 38,
    }),
  };

  const env = { get: jest.fn().mockReturnValue(true) } as unknown as EnvService;

  return {
    useCase: new ApplyRecommendationUseCase(
      recommendations as never,
      outcomes as never,
      env,
    ),
    recommendations,
    outcomes,
    marked,
  };
}

const run = (h: ReturnType<typeof build>, dryRun = true) =>
  h.useCase.execute({
    organizationId: 'org-1',
    id: 'reco-1',
    body: { dryRun },
  });

describe('premissa vencida ⇒ 409 tipado e expiração imediata', () => {
  it('evidência velha: erro tipado, motivo visível, EXPIRED gravado', async () => {
    const h = build({
      premise: premise({
        evidenceAsOf: new Date(Date.now() - 10 * 86_400_000),
      }),
    });

    await expect(run(h)).rejects.toMatchObject({
      code: 'RECOMMENDATION_PREMISE_STALE',
      category: 'PRECONDITION_FAILED',
      details: { check: 'EVIDENCE_FRESH', expired: true },
    });

    // O gate: a expiração é **escrita**, não só decidida.
    expect(h.marked).toEqual([expect.objectContaining({ status: 'EXPIRED' })]);
    expect(h.marked[0].reason).toContain('10 dias');
  });

  it('escrita em voo: 409 WRITE_IN_FLIGHT e a recomendação NÃO expira', async () => {
    // O alvo se libera sozinho; expirar aqui apagaria uma recomendação correta.
    const h = build({ premise: premise({ writeInFlightId: 'exec-9' }) });

    await expect(run(h)).rejects.toMatchObject({
      code: 'WRITE_IN_FLIGHT',
      category: 'WRITE_IN_FLIGHT',
    });
    expect(h.marked).toEqual([]);
  });

  it('cada código leva a categoria que a tela precisa (§7.0.4)', async () => {
    const casos: Array<[Partial<PremiseState>, string, string]> = [
      [
        { integrationReachable: false },
        'INTEGRATION_UNREACHABLE',
        'INTEGRATION_UNREACHABLE',
      ],
      [{ consentGranted: false }, 'WRITE_CONSENT_REQUIRED', 'CONSENT_REQUIRED'],
      [{ killSwitchOn: true }, 'PLATFORM_ACTIONS_DISABLED', 'KILL_SWITCH'],
      [
        { capabilitySupported: false },
        'ACTION_UNSUPPORTED',
        'UNSUPPORTED_BY_PLATFORM',
      ],
    ];

    for (const [override, code, category] of casos) {
      const h = build({ premise: premise(override) });
      await expect(run(h)).rejects.toMatchObject({ code, category });
    }
  });
});

describe('dry-run devolve o plano e a linha de base do outcome (C8)', () => {
  it('a premissa é revalidada e o plano volta com alvo e parâmetros', async () => {
    const h = build();

    const result = await run(h);

    expect(result.data.premise.valid).toBe(true);
    expect(result.data.plan[0]).toMatchObject({
      type: 'PAUSE_AD',
      target: { type: 'AD', id: 'ad-1' },
    });
    expect(result.data.estimatedEffect[0]).toMatchObject({ type: 'SAVINGS' });
  });

  it('o baseline é o MESMO snapshot que A2-S7 vai gravar', async () => {
    // Exposto antes de qualquer escrita porque é a régua contra a qual o impacto
    // será medido: vê-la depois faria a medição ser uma surpresa.
    const h = build();

    const result = await run(h);

    expect(result.data.outcomeBaseline).toMatchObject({
      preSpendBase: 1_400,
      preConversions: 0,
      preAiScore: 38,
      // DEC-6: o delta primário é declarado na geração, não escolhido na medição.
      observedDeltaKind: 'SPEND_AVOIDED',
      // M4: a taxa de `appliedAt`, fixada para as duas janelas.
      fxRateFixed: 1,
    });
  });

  it('a procedência declara a versão do motor e a janela', async () => {
    const h = build();

    const result = await run(h);

    expect(result.meta.provenance).toEqual({
      engineVersion: 'reco-v2.0.0',
      windowDays: 14,
    });
  });
});

describe('recusas antes de chegar à premissa', () => {
  it('consultiva não tem o que aplicar', async () => {
    const h = build({
      recommendation: view({
        advisory: true,
        outOfScopeReason: 'A Allva não gere audiências.',
        guidance: 'Amplie no gerenciador.',
        actions: [],
      }),
    });

    await expect(run(h)).rejects.toMatchObject({
      code: 'RECOMMENDATION_IS_ADVISORY',
      category: 'UNSUPPORTED_BY_PLATFORM',
    });
    // Nem chega a consultar o estado: não há premissa a revalidar.
    expect(h.recommendations.premiseStateFor).not.toHaveBeenCalled();
  });

  /**
   * A recusa de `dryRun: false` **saiu** em A2-S9: a escrita real existe, e a
   * rota mudou de módulo junto com ela (D3). O que este use case garante agora é
   * que `revalidate` — a única porta para o plano, chamada por
   * `platform-actions` antes de qualquer escrita — devolve a recomendação
   * inteira depois de rodar o passo 1.
   */
  it('revalidate devolve o plano depois de checar a premissa', async () => {
    const h = build();

    const revalidated = await h.useCase.revalidate({
      organizationId: 'org-1',
      id: 'reco-1',
    });

    expect(revalidated.id).toBe('reco-1');
    expect(h.recommendations.premiseStateFor).toHaveBeenCalled();
  });

  it('revalidate propaga a recusa de premissa vencida', async () => {
    const h = build({ premise: premise({ adArchived: true }) });

    await expect(
      h.useCase.revalidate({ organizationId: 'org-1', id: 'reco-1' }),
    ).rejects.toMatchObject({ category: 'PRECONDITION_FAILED' });
  });

  it('recomendação inexistente é 404', async () => {
    const h = build({ recommendation: null });

    await expect(run(h)).rejects.toBeInstanceOf(NotFoundException);
  });
});
