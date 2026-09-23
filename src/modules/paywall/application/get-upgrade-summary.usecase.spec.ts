import { Logger } from '@nestjs/common';
import { GetUpgradeSummaryUseCase } from './get-upgrade-summary.usecase';

function money(valueBase: number, baseCurrency = 'BRL') {
  return {
    value: valueBase,
    currency: baseCurrency,
    valueBase,
    baseCurrency,
  };
}

function wasteSummary(overrides: Record<string, unknown> = {}) {
  return {
    openCount: 47,
    affectedAds: 23,
    incurred: money(4812.35),
    avoidableDaily: money(210.4),
    byPriority: {},
    byType: {},
    asOf: new Date('2026-08-20T03:12:00.000Z'),
    excludedByWindowMismatch: 0,
    ...overrides,
  };
}

function impactSummary(overrides: Record<string, unknown> = {}) {
  return {
    baseCurrency: 'BRL',
    byType: [
      {
        type: 'WASTE_REDUCTION',
        openEstimatedBase: 0,
        openCount: 0,
        appliedEstimatedBase: 0,
        appliedCount: 4,
        observedDeltaBase: -900,
        measuredCount: 3,
        byVerdict: { IMPROVED: 3, WORSENED: 1 },
      },
      {
        type: 'SCALE',
        openEstimatedBase: 0,
        openCount: 0,
        appliedEstimatedBase: 0,
        appliedCount: 2,
        observedDeltaBase: 120,
        measuredCount: 2,
        byVerdict: { IMPROVED: 1, UNCHANGED: 1 },
      },
    ],
    advisoryExcluded: 0,
    measurement: {
      pending: 1,
      measured: 5,
      abandoned: 0,
      withConfounders: 0,
      versions: ['v1'],
    },
    ...overrides,
  };
}

function buildHarness(
  options: {
    organizationId?: string | null;
    waste?: unknown;
    impact?: unknown;
    wasteThrows?: boolean;
    impactThrows?: boolean;
    settingsThrows?: boolean;
    scopeThrows?: boolean;
    excludedAds?: number;
  } = {},
) {
  const scope = {
    resolveForAccount: options.scopeThrows
      ? jest.fn().mockRejectedValue(new Error('scope down'))
      : jest.fn().mockResolvedValue({
          accountId: 'acc-1',
          organizationId:
            options.organizationId === undefined
              ? 'org-1'
              : options.organizationId,
        }),
  };

  const waste = {
    summary: options.wasteThrows
      ? jest.fn().mockRejectedValue(new Error('WASTE_DETECTOR_DISABLED'))
      : jest.fn().mockResolvedValue(options.waste ?? wasteSummary()),
  };

  const wasteSettings = {
    forOrganization: options.settingsThrows
      ? jest.fn().mockRejectedValue(new Error('settings down'))
      : jest.fn().mockResolvedValue({
          organizationId: 'org-1',
          windowDays: 21,
          detectorProfileVersion: 'waste-thresholds-v1',
          baseCurrency: 'BRL',
          recomputingCurrency: false,
        }),
  };

  const recommendations = {
    impactSummary: options.impactThrows
      ? jest.fn().mockRejectedValue(new Error('RECOMMENDATION_ENGINE_DISABLED'))
      : jest.fn().mockResolvedValue(options.impact ?? impactSummary()),
  };

  const analysisScope = {
    countExcluded: jest.fn().mockResolvedValue(options.excludedAds ?? 0),
  };

  const useCase = new GetUpgradeSummaryUseCase(
    scope as never,
    waste as never,
    wasteSettings as never,
    recommendations as never,
    analysisScope as never,
  );

  return {
    useCase,
    scope,
    waste,
    wasteSettings,
    recommendations,
    analysisScope,
  };
}

describe('resumo de contratação', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('devolve os números do cliente, na moeda-base da organização', async () => {
    const { useCase } = buildHarness();

    await expect(useCase.execute('acc-1')).resolves.toEqual({
      state: 'READY',
      wasteFound: { amount: 4812.35, currency: 'BRL' },
      avoidableDaily: { amount: 210.4, currency: 'BRL' },
      affectedAds: 23,
      openFindings: 47,
      actionsApplied: 6,
      outcomesImproved: 4,
      outcomesMeasured: 5,
      windowDays: 21,
      adsExcludedByPlanLimit: 0,
      asOf: '2026-08-20T03:12:00.000Z',
    });
  });

  it('lê o desperdício sob a janela vigente da organização, não sob um padrão', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1');

    expect(h.waste.summary).toHaveBeenCalledWith({
      organizationId: 'org-1',
      windowDays: 21,
    });
  });

  it('não expõe nenhum campo de economia atribuída (D6)', async () => {
    const { useCase } = buildHarness();
    const result = await useCase.execute('acc-1');

    // O produto mede pré/pós e rotula `observedDelta`, jamais `causedSavings`.
    // A tela de vendas é onde essa distinção mais facilmente morreria.
    for (const key of Object.keys(result)) {
      expect(key).not.toMatch(/saved|savings|recovered|recuperad/i);
    }
  });
});

describe('o paywall nunca falha', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('detector desligado por flag ainda abre a tela, com o que sobrou', async () => {
    const { useCase } = buildHarness({ wasteThrows: true });
    const result = await useCase.execute('acc-1');

    expect(result.state).toBe('READY');
    expect(result.wasteFound).toBeNull();
    // O lado que respondeu continua valendo.
    expect(result.actionsApplied).toBe(6);
  });

  it('motor de recomendação desligado não apaga o desperdício encontrado', async () => {
    const { useCase } = buildHarness({ impactThrows: true });
    const result = await useCase.execute('acc-1');

    expect(result.state).toBe('READY');
    expect(result.wasteFound).toEqual({ amount: 4812.35, currency: 'BRL' });
    expect(result.actionsApplied).toBe(0);
    expect(result.outcomesMeasured).toBe(0);
  });

  it('com as duas fontes fora, degrada para NO_DATA em vez de erro', async () => {
    const { useCase } = buildHarness({
      wasteThrows: true,
      impactThrows: true,
    });

    await expect(useCase.execute('acc-1')).resolves.toMatchObject({
      state: 'NO_DATA',
      wasteFound: null,
      affectedAds: 0,
    });
  });

  it('conta sem organização devolve NO_DATA sem consultar inteligência', async () => {
    const h = buildHarness({ organizationId: null });

    await expect(h.useCase.execute('acc-1')).resolves.toMatchObject({
      state: 'NO_DATA',
    });
    expect(h.waste.summary).not.toHaveBeenCalled();
    expect(h.recommendations.impactSummary).not.toHaveBeenCalled();
  });

  it('escopo indisponível não derruba a tela de pagamento', async () => {
    const { useCase } = buildHarness({ scopeThrows: true });

    await expect(useCase.execute('acc-1')).resolves.toMatchObject({
      state: 'NO_DATA',
    });
  });

  it('configuração indisponível cai na janela padrão e segue lendo', async () => {
    const h = buildHarness({ settingsThrows: true });
    const result = await h.useCase.execute('acc-1');

    expect(result.windowDays).toBe(14);
    expect(h.waste.summary).toHaveBeenCalledWith({
      organizationId: 'org-1',
      windowDays: 14,
    });
  });

  it('registra a degradação — paywall zerado por bug e por conta nova são iguais sem log', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await buildHarness({ wasteThrows: true }).useCase.execute('acc-1');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('paywall.source_unavailable fonte=waste'),
    );
  });
});

describe('organização sem nenhum achado', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('responde READY com zeros — não achar nada é um resultado, não uma falha', async () => {
    const { useCase } = buildHarness({
      waste: wasteSummary({
        openCount: 0,
        affectedAds: 0,
        incurred: null,
        avoidableDaily: null,
        asOf: null,
      }),
    });

    await expect(useCase.execute('acc-1')).resolves.toMatchObject({
      state: 'READY',
      wasteFound: null,
      avoidableDaily: null,
      openFindings: 0,
      asOf: null,
    });
  });
});

describe('o teto de anúncios analisados aparece na tela', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('declara quantos anúncios ficaram fora da análise', async () => {
    const { useCase } = buildHarness({ excludedAds: 4512 });
    const result = await useCase.execute('acc-1');

    // Sem este número, "R$ 4.812 encontrados" sobre 300 de 5.000 anúncios lê
    // como se fosse o total da organização.
    expect(result.adsExcludedByPlanLimit).toBe(4512);
  });

  it('a contagem indisponível não derruba a tela', async () => {
    const h = buildHarness();
    h.analysisScope.countExcluded.mockRejectedValue(new Error('fora do ar'));

    await expect(h.useCase.execute('acc-1')).resolves.toMatchObject({
      state: 'READY',
      adsExcludedByPlanLimit: 0,
    });
  });
});
