import { conversionTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import { GenerateRecommendationsService } from './generate-recommendations.service';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import type { EnvService } from 'src/shared/infrastructure/config/env.service';
import type { GenerationSettings } from 'src/modules/recommendations/domain/ports/recommendation-targets.repository';
import type { PersistPlanInput } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import type {
  PolicyThresholds,
  RecommendationSignals,
} from 'src/modules/recommendations/domain/recommendation-plan';
import type { ActiveSuppression } from 'src/modules/recommendations/domain/suppression';

/**
 * Os nove passos de §9.4 contra dublês.
 *
 * O que este teste fixa não é a política — ela tem os próprios — e sim a
 * **orquestração**: a guarda do passo 1, a supressão do 3d, o conflito do 4 e o
 * evento do 9. Três deles decidem se algo chega ou não à tela do usuário, e o
 * quarto é o que faz `alerts` e `audit` existirem sem injeção direta.
 */

const THRESHOLDS: PolicyThresholds = {
  scaleMinScore: 75,
  scaleMinConfidence: 0.7,
  scaleMinCoverageRatio: 0.8,
  scaleRoasMultiple: 2,
  scaleMaxFatigue: 0.5,
  saturationFrequency: 3.5,
  minLearningStability: 40,
  budgetReductionFactor: 0.3,
  scaleIncreaseFactor: 0.2,
  impactHorizonDays: 14,
  expiryDays: 7,
};

function settings(
  overrides: Partial<GenerationSettings> = {},
): GenerationSettings {
  return {
    organizationId: 'org-1',
    accountId: 'acc-1',
    baseCurrency: 'BRL',
    windowDays: 14,
    engineVersion: 'reco-v2.0.0',
    thresholds: THRESHOLDS,
    generationAllowed: true,
    blockedReason: null,
    ...overrides,
  };
}

/**
 * Um anúncio com `ZERO_CONVERSIONS` aberto: vira `PAUSE_UNDERPERFORMING_AD`.
 *
 * `ad` aceita override parcial — cada teste declara só a fronteira que exercita.
 */
function signalsFor(
  adId: string,
  overrides: Partial<Omit<RecommendationSignals, 'ad'>> & {
    ad?: Partial<RecommendationSignals['ad']>;
  } = {},
): RecommendationSignals {
  return {
    ad: {
      adId,
      adSetId: 'set-1',
      campaignId: 'campaign-1',
      adAccountId: 'account-1',
      platform: 'META',
      creativeId: 'creative-1',
      creativeFormat: null,
      contentHash: 'hash-1',
      isDelivering: true,
      dataMaturity: 'MATURE',
      currency: 'BRL',
      baseCurrency: 'BRL',
      frequency: 2,
      optimization: conversionTarget('PURCHASE'),
      cpa: null,
      peerMedianCpa: null,
      roas: 0,
      // Sem mediana de pares: `REPLACE_CTA` não tem contra o que comparar e não
      // dispara. A fixture isola o caminho do achado — quem exercita o CTA o
      // declara, em vez de recebê-lo de brinde e ter de contá-lo em todo teste.
      peerMedianRoas: null,
      adSetDailyBudget: 100,
      campaignDailyBudget: 500,
      ...overrides.ad,
    },
    findings: overrides.findings ?? [
      {
        id: `item-${adId}`,
        type: 'ZERO_CONVERSIONS',
        findingKind: 'WASTE',
        priority: 'CRITICAL',
        avoidableDailyBase: 100,
        avoidableDaily: 100,
        incurredBase: 1_400,
        evidenceSufficiency: 'SUFFICIENT',
        dataMaturity: 'MATURE',
      },
    ],
    score: overrides.score ?? {
      aiScore: 30,
      aiConfidence: 0.8,
      coverageRatio: 1,
      fatigueScore: 0.1,
      learningStability: 80,
      audienceFit: 70,
      negativeFeedbackRisk: 10,
      delta7d: null,
      scoredAt: new Date('2026-08-02T00:00:00.000Z'),
    },
    adSetFindingTypes: [],
    replacementCreativeId: null,
    selectedCopy: null,
    replacementRationale: null,
    thresholds: THRESHOLDS,
    now: new Date('2026-08-02T12:00:00.000Z'),
  };
}

function build(
  input: {
    settings?: Partial<GenerationSettings>;
    signals?: RecommendationSignals[];
    suppressions?: ActiveSuppression[];
    enabled?: boolean;
    persistFails?: boolean;
  } = {},
) {
  const persisted: PersistPlanInput[] = [];
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];

  const targets = {
    settingsForOrganization: jest
      .fn()
      .mockResolvedValue(settings(input.settings)),
    loadSignals: jest
      .fn()
      .mockResolvedValue(input.signals ?? [signalsFor('ad-1')]),
    scopeCounts: jest.fn().mockResolvedValue({
      adsByAdSetId: new Map([['set-1', 8]]),
      adsByCampaignId: new Map([['campaign-1', 20]]),
    }),
    activeSuppressions: jest.fn().mockResolvedValue(input.suppressions ?? []),
    listOrganizationsToGenerate: jest.fn(),
  };

  const recommendations = {
    persistPlan: jest.fn(async (call: PersistPlanInput) => {
      persisted.push(call);
      if (input.persistFails) return null;
      return {
        id: `reco-${persisted.length}`,
        adId: call.plan.adId,
        kind: call.plan.kind,
        actionIds: call.plan.actions.map((_, index) => `action-${index}`),
      };
    }),
    supersede: jest.fn(),
  };

  const events = {
    emitFrom: jest.fn(
      (_ctx, name: string, payload: Record<string, unknown>) => {
        emitted.push({ name, payload });
        return { eventId: 'evt' };
      },
    ),
  };

  const env = {
    get: jest.fn().mockReturnValue(input.enabled ?? true),
  } as unknown as EnvService;

  return {
    service: new GenerateRecommendationsService(
      targets as never,
      recommendations as never,
      events as never,
      env,
    ),
    targets,
    recommendations,
    persisted,
    emitted,
  };
}

const run = (h: ReturnType<typeof build>) =>
  h.service.execute({
    organizationId: 'org-1',
    ctx: createRootJobContext(),
    now: new Date('2026-08-02T12:00:00.000Z'),
  });

describe('§9.4 passo 1 — a guarda', () => {
  it('recomputo de moeda em curso pausa a geração', async () => {
    // Gerar durante o recomputo produziria um plano cujo valor estimado está numa
    // unidade e metade da base, em outra.
    const h = build({
      settings: {
        generationAllowed: false,
        blockedReason: 'CURRENCY_RECOMPUTING',
      },
    });

    const outcome = await run(h);

    expect(outcome.blockedReason).toBe('CURRENCY_RECOMPUTING');
    expect(h.persisted).toEqual([]);
    expect(h.targets.loadSignals).not.toHaveBeenCalled();
  });

  it('motor desligado nem consulta as settings', async () => {
    const h = build({ enabled: false });

    const outcome = await run(h);

    expect(outcome.blockedReason).toBe('FEATURE_DISABLED');
    expect(h.targets.settingsForOrganization).not.toHaveBeenCalled();
  });
});

describe('§9.4 passos 3 a 5 — plano, supressão e persistência', () => {
  it('persiste o plano como NEW e emite recommendation.generated', async () => {
    const h = build();

    const outcome = await run(h);

    expect(outcome.persisted).toBe(1);
    expect(h.persisted[0].deferral).toBeNull();
    expect(h.persisted[0].engineVersion).toBe('reco-v2.0.0');

    const event = h.emitted.find(
      (item) => item.name === 'recommendation.generated',
    );
    expect(event?.payload).toMatchObject({
      adId: 'ad-1',
      kind: 'PAUSE_UNDERPERFORMING_AD',
      actionIds: ['action-0'],
    });
  });

  it('supressão ativa silencia o kind — o motor escuta (3d)', async () => {
    const h = build({
      suppressions: [
        {
          id: 'sup-1',
          kind: 'PAUSE_UNDERPERFORMING_AD',
          scope: 'AD',
          scopeId: 'ad-1',
          expiresAt: null,
          reason: 'campanha institucional',
        },
      ],
    });

    const outcome = await run(h);

    expect(outcome.suppressed).toBe(1);
    expect(outcome.persisted).toBe(0);
    expect(h.persisted).toEqual([]);
  });

  it('supressão vencida não silencia — a leitura não espera o job de purga', async () => {
    const h = build({
      suppressions: [
        {
          id: 'sup-1',
          kind: 'PAUSE_UNDERPERFORMING_AD',
          scope: 'AD',
          scopeId: 'ad-1',
          expiresAt: new Date('2026-08-01T00:00:00.000Z'),
          reason: 'antiga',
        },
      ],
    });

    expect((await run(h)).persisted).toBe(1);
  });

  it('supressão de ORGANIZAÇÃO vale para todo anúncio dela', async () => {
    const h = build({
      signals: [signalsFor('ad-1'), signalsFor('ad-2')],
      suppressions: [
        {
          id: 'sup-1',
          kind: 'PAUSE_UNDERPERFORMING_AD',
          scope: 'ORGANIZATION',
          scopeId: null,
          expiresAt: null,
          reason: 'decisão da conta',
        },
      ],
    });

    expect((await run(h)).suppressed).toBe(2);
  });

  it('o aviso de escopo carrega a contagem real (§9.2)', async () => {
    // A política sabe **que** a ação incide acima do anúncio; só a aplicação sabe
    // sobre quantos. Um aviso que não dimensiona é um aviso que se ignora.
    const h = build({
      signals: [
        signalsFor('ad-1', {
          findings: [
            {
              id: 'item-1',
              type: 'HIGH_CPA',
              findingKind: 'WASTE',
              priority: 'HIGH',
              avoidableDailyBase: 50,
              avoidableDaily: 50,
              incurredBase: 700,
              evidenceSufficiency: 'SUFFICIENT',
              dataMaturity: 'MATURE',
            },
          ],
        }),
      ],
    });

    await run(h);

    expect(h.persisted[0].plan.actions[0].scopeWarning).toBe(
      'Afeta os 8 anúncios deste conjunto, não apenas este.',
    );
  });

  it('recusa do índice parcial é contada, não explode', async () => {
    // Geração concorrente: a segunda encontra uma ativa para `(ad, kind)` e é
    // recusada pelo banco. Recusar é o comportamento correto.
    const h = build({ persistFails: true });

    const outcome = await run(h);

    expect(outcome.alreadyActive).toBe(1);
    expect(outcome.persisted).toBe(0);
    expect(h.emitted).toEqual([]);
  });
});

describe('§9.4 passo 4 — conflito no mesmo alvo', () => {
  it('dois ads do mesmo conjunto: uma vence, a outra fica DEFERRED', async () => {
    const caro = signalsFor('ad-caro', {
      findings: [
        {
          id: 'item-caro',
          type: 'HIGH_CPA',
          findingKind: 'WASTE',
          priority: 'CRITICAL',
          avoidableDailyBase: 200,
          avoidableDaily: 200,
          incurredBase: 2_800,
          evidenceSufficiency: 'SUFFICIENT',
          dataMaturity: 'MATURE',
        },
      ],
    });

    const campeao = signalsFor('ad-campeao', {
      ad: { adId: 'ad-campeao', roas: 4, peerMedianRoas: 1 },
      findings: [
        {
          id: 'item-campeao',
          type: 'BUDGET_STARVATION',
          findingKind: 'OPPORTUNITY',
          priority: 'MEDIUM',
          avoidableDailyBase: 900,
          avoidableDaily: 900,
          incurredBase: 0,
          evidenceSufficiency: 'SUFFICIENT',
          dataMaturity: 'MATURE',
        },
      ],
      score: {
        aiScore: 90,
        aiConfidence: 0.9,
        coverageRatio: 1,
        fatigueScore: 0.1,
        learningStability: 80,
        audienceFit: 80,
        negativeFeedbackRisk: 10,
        delta7d: 1,
        scoredAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    });

    const h = build({ signals: [caro, campeao] });

    const outcome = await run(h);

    expect(outcome.persisted).toBe(1);
    expect(outcome.deferred).toBe(1);

    const deferida = h.persisted.find((call) => call.deferral !== null);
    expect(deferida?.plan.kind).toBe('SCALE_WINNING_AD');
    // A vencedora é apontada: sem `conflictWithId`, o job de ciclo de vida não
    // teria como saber quando o conflito cessou (⊕7).
    expect(deferida?.deferral?.conflictWithId).toBe('reco-1');
    expect(deferida?.deferral?.reason).toContain('Conflito no mesmo alvo');

    // Só a vencedora emite: a diferida não está na tela e não gerou plano ativo.
    expect(
      h.emitted.filter((item) => item.name === 'recommendation.generated'),
    ).toHaveLength(1);
  });
});
