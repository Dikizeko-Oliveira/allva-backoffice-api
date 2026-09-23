import { AnalyzeAdUseCase } from './analyze-ad.usecase';
import { AnalysisProductionService } from 'src/modules/creative-lab/application/services/analysis-production.service';
import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type {
  AnalysisSubject,
  StoredAnalysis,
} from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';

/**
 * `aiReadingIncludedInPlan` na resposta da análise.
 *
 * O campo existe para separar as duas ausências de narrativa que chegavam à
 * tela idênticas: "seu plano não inclui a leitura com IA" — acionável, e a tela
 * oferece o upgrade — e "a IA não falou desta vez", que não é. Sem ele, o
 * Individual via o diagnóstico e nada mais, sem saber que havia algo a fazer.
 *
 * O caso que mais importa aqui é o **reuso de P9**: ele devolve a análise
 * guardada sem passar pelo enriquecimento, então não há `outcome` fresco de
 * onde tirar o motivo — e é justamente no reuso que a pessoa reabre a tela e
 * reencontra a narrativa ausente.
 */

const SUBJECT: AnalysisSubject = {
  adId: 'ad-1',
  adSetId: 'adset-1',
  adName: 'Anúncio 1',
  platform: 'META',
  creativeId: 'creative-1',
  contentHash: 'hash-conteudo',
  metricsDigest: 'digest-1',
  accountId: 'acc-1',
  adAccountId: 'adacc-1',
  copy: {
    headline: 'Reduza 6 horas de trabalho manual por semana',
    body: 'Times de performance usam a Allva para achar o desperdício antes do fim do mês.',
    callToAction: 'LEARN_MORE',
  },
};

/** As quatro colunas vazias — o estado de toda análise anterior ao produtor. */
const NO_SUGGESTIONS = {
  schemaVersion: 1 as const,
  items: [],
  withheld: null,
};

function score(): AdScoreView {
  return {
    adId: 'ad-1',
    adScoreId: 'score-1',
    aiScore: 72,
    aiConfidence: 0.8,
    componentCoverage: 1,
    coverageRatio: 1,
    algoVersion: 'v1',
    scoreDate: new Date('2026-09-01'),
    scoredAt: new Date('2026-09-01'),
    windowDays: 7,
    delta7d: null,
    seriesDiscontinuity: null,
    frozenAt: null,
    components: {},
    context: null,
    narrative: null,
  };
}

function storedAnalysis(
  overrides: Partial<StoredAnalysis> = {},
): StoredAnalysis {
  return {
    id: 'analysis-1',
    adId: 'ad-1',
    creativeId: 'creative-1',
    version: 1,
    status: 'COMPLETED',
    trigger: 'MANUAL',
    metricsDigest: 'digest-1',
    diagnostics: {
      dispersion: 0.3,
      verdict: 'CONSISTENT',
      comparedAdIds: ['ad-1', 'ad-2', 'ad-3'],
      excluded: [],
      narrative: null,
    },
    candidates: [],
    suggestions: {
      hook: NO_SUGGESTIONS,
      body: NO_SUGGESTIONS,
      cta: NO_SUGGESTIONS,
      format: NO_SUGGESTIONS,
    },
    engineVersion: 'creative-v2.0.0',
    enrichedByAI: false,
    narrative: null,
    completedAt: new Date('2026-09-02'),
    ...overrides,
  };
}

function buildHarness(options: {
  planAllows: boolean;
  previous?: StoredAnalysis;
}) {
  const analyses = {
    subjectFor: jest.fn().mockResolvedValue(SUBJECT),
    latestFor: jest.fn().mockResolvedValue(options.previous ?? null),
    adsOfCreative: jest.fn().mockResolvedValue([]),
    candidatesFor: jest.fn().mockResolvedValue([]),
    persist: jest.fn().mockResolvedValue(storedAnalysis()),
  };

  const scores = {
    currentByAdIds: jest.fn().mockResolvedValue(new Map([['ad-1', score()]])),
  };

  const enrichment = {
    enrich: jest.fn().mockResolvedValue({
      narrative: null,
      provider: null,
      model: null,
      outcome: 'SKIPPED_PLAN',
    }),
  };

  const planEntitlement = {
    allows: jest.fn().mockResolvedValue(options.planAllows),
  };

  /**
   * A cota vive num serviço próprio, e o dublê responde o par que a resposta
   * carrega. Os testes deste arquivo são sobre `aiReadingIncludedInPlan`; a
   * guarda em si tem suíte própria em `analysis-quota.service.spec.ts`.
   */
  const quotas = {
    usage: jest.fn().mockResolvedValue({ limit: 3_000, used: 3 }),
    reserve: jest.fn().mockResolvedValue({ limit: 3_000, used: 4 }),
    release: jest.fn().mockResolvedValue(undefined),
  };

  /**
   * O serviço de produção real, com os mesmos dublês: o que estes testes
   * verificam é `aiReadingIncludedInPlan` na resposta, e ele é montado lá.
   */
  const production = new AnalysisProductionService(
    analyses as never,
    enrichment as never,
  );

  const useCase = new AnalyzeAdUseCase(
    analyses as never,
    scores as never,
    planEntitlement as never,
    quotas as never,
    production,
  );

  return { useCase, analyses, enrichment, planEntitlement, quotas };
}

type AnalysisResponse = { data: { aiReadingIncludedInPlan: boolean } };

describe('AnalyzeAdUseCase — leitura com IA e plano', () => {
  it('diz que o plano não inclui a leitura com IA', async () => {
    const h = buildHarness({ planAllows: false });

    const response = (await h.useCase.execute({
      organizationId: 'org-1',
      adId: 'ad-1',
    })) as unknown as AnalysisResponse;

    expect(response.data.aiReadingIncludedInPlan).toBe(false);
    expect(h.planEntitlement.allows).toHaveBeenCalledWith({
      organizationId: 'org-1',
      feature: 'creative-lab',
    });
  });

  it('diz que o plano inclui, quando inclui', async () => {
    const h = buildHarness({ planAllows: true });

    const response = (await h.useCase.execute({
      organizationId: 'org-1',
      adId: 'ad-1',
    })) as unknown as AnalysisResponse;

    expect(response.data.aiReadingIncludedInPlan).toBe(true);
  });

  it('responde igual no reuso de P9, que não passa pelo enriquecimento', async () => {
    const h = buildHarness({
      planAllows: false,
      // Mesmo `metricsDigest` do subject: é o curto-circuito de P9.
      previous: storedAnalysis({ metricsDigest: 'digest-1' }),
    });

    const response = (await h.useCase.execute({
      organizationId: 'org-1',
      adId: 'ad-1',
    })) as unknown as AnalysisResponse & {
      data: { reusedPreviousAnalysis: boolean };
    };

    expect(response.data.reusedPreviousAnalysis).toBe(true);
    expect(h.enrichment.enrich).not.toHaveBeenCalled();
    /**
     * O caminho que motivou resolver isto na leitura em vez de gravar o
     * `SKIPPED_PLAN` junto da análise: aqui não há enriquecimento de onde tirar
     * o motivo, e é este o caminho que a pessoa percorre ao reabrir a tela.
     */
    expect(response.data.aiReadingIncludedInPlan).toBe(false);
  });

  it('acompanha o upgrade sem reanalisar: a mesma análise guardada passa a incluir', async () => {
    const previous = storedAnalysis({ metricsDigest: 'digest-1' });
    const h = buildHarness({ planAllows: true, previous });

    const response = (await h.useCase.execute({
      organizationId: 'org-1',
      adId: 'ad-1',
    })) as unknown as AnalysisResponse;

    /**
     * Um `SKIPPED_PLAN` carimbado na linha continuaria dizendo "não incluído"
     * depois do upgrade — logo depois de a pessoa pagar, que é o pior momento
     * para errar isso. Lido do plano vigente, a oferta some na hora.
     */
    expect(response.data.aiReadingIncludedInPlan).toBe(true);
  });
});
