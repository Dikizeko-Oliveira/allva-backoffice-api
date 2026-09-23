import { Logger } from '@nestjs/common';
import { AnalysisScopeService } from './analysis-scope.service';

function buildHarness(
  options: {
    planType?: string | null;
    organizations?: string[];
    planThrows?: boolean;
    /** Teto de contrato, quando existe. `undefined` = herda o plano. */
    negotiatedMonitoredAds?: number;
  } = {},
) {
  const scope = {
    listOrganizationsWithAds: jest
      .fn()
      .mockResolvedValue(options.organizations ?? ['org-1']),
    markEligible: jest.fn().mockImplementation(({ organizationId }) =>
      Promise.resolve({
        organizationId,
        eligible: 300,
        excludedByPlanLimit: 4700,
      }),
    ),
    countExcluded: jest.fn(),
  };

  const plans = {
    findPlanTypeByOrganizationId: options.planThrows
      ? jest.fn().mockRejectedValue(new Error('plano indisponível'))
      : jest
          .fn()
          .mockResolvedValue(
            options.planType === undefined ? 'STARTER' : options.planType,
          ),
  };

  // `null` = sem contrato negociado, que é o caso de quase toda organização.
  const quotas = {
    findOverrides: jest.fn().mockResolvedValue({
      adAccounts: null,
      monitoredAds: options.negotiatedMonitoredAds ?? null,
      seats: null,
    }),
  };

  // A porta de acesso deixa passar todas: o que se testa aqui é a régua.
  const sweep = {
    keepByMode: jest.fn(async (items: string[]) => ({
      kept: items,
      skipped: 0,
    })),
  };

  return {
    service: new AnalysisScopeService(
      scope as never,
      plans as never,
      quotas as never,
      sweep as never,
    ),
    scope,
    plans,
    quotas,
    sweep,
  };
}

describe('a régua de quantos anúncios são analisados', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('aplica o teto do plano da organização', async () => {
    const h = buildHarness({ planType: 'STARTER' });

    await h.service.execute(new Date('2026-08-20T05:00:00.000Z'));

    expect(h.scope.markEligible).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', limit: 300 }),
    );
  });

  it('plano sem teto carimba tudo em vez de pular a corrida', async () => {
    // Pular faria o filtro dos motores precisar saber o plano; carimbando
    // sempre, a condição deles é uma só: `analysisEligibleAt IS NOT NULL`.
    // Hoje quem chega aqui é o plano irresolúvel — o Enterprise passou a ter
    // piso, e ilimitado deixou de existir.
    const h = buildHarness({ planType: null });

    await h.service.execute();

    expect(h.scope.markEligible).toHaveBeenCalledWith(
      expect.objectContaining({ limit: null }),
    );
  });

  it('o Enterprise aplica o piso do contrato', async () => {
    const h = buildHarness({ planType: 'ENTERPRISE' });

    await h.service.execute();

    expect(h.scope.markEligible).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5_000 }),
    );
  });

  it('o teto negociado vence o do plano', async () => {
    // O mesmo contrato que governa o vínculo de conta precisa governar a régua
    // da madrugada: valer num e não no outro apareceria como "sumiram anúncios
    // da análise", sem ninguém relacionar as duas coisas.
    const h = buildHarness({
      planType: 'ENTERPRISE',
      negotiatedMonitoredAds: 40_000,
    });

    await h.service.execute();

    expect(h.scope.markEligible).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 40_000 }),
    );
  });

  it('ordena sobre uma janela, não sobre a série inteira', async () => {
    const h = buildHarness();
    const now = new Date('2026-08-20T05:00:00.000Z');

    await h.service.execute(now);

    const { since, until } = h.scope.markEligible.mock.calls[0][0] as {
      since: Date;
      until: Date;
    };

    expect(until).toEqual(now);
    const days =
      (until.getTime() - since.getTime()) / (24 * 60 * 60 * 1000) + 1;
    expect(days).toBe(14);
  });

  it('plano irresolúvel NÃO corta ninguém', async () => {
    // Assimetria deliberada contra `planAllows`, que fecha na dúvida: lá, o
    // erro do lado permissivo escreve em mídia paga; aqui, o erro do lado
    // restritivo faria a organização sumir da análise numa madrugada e o
    // produto reportaria zero desperdício como fato sobre a mídia.
    const h = buildHarness({ planType: null });

    await h.service.execute();

    expect(h.scope.markEligible).toHaveBeenCalledWith(
      expect.objectContaining({ limit: null }),
    );
  });

  it('uma organização que falha não derruba a régua das outras', async () => {
    const h = buildHarness({ organizations: ['org-1', 'org-2', 'org-3'] });
    h.plans.findPlanTypeByOrganizationId.mockRejectedValueOnce(
      new Error('indisponível'),
    );

    const run = await h.service.execute();

    expect(h.scope.markEligible).toHaveBeenCalledTimes(2);
    expect(run.organizations).toBe(3);
  });

  it('soma o que ficou de fora — é o número que a tela declara', async () => {
    const h = buildHarness({ organizations: ['org-1', 'org-2'] });

    const run = await h.service.execute();

    expect(run.excludedByPlanLimit).toBe(9400);
    expect(run.eligible).toBe(600);
  });
});
