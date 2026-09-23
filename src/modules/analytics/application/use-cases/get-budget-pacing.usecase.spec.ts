import { GetBudgetPacingUseCase } from './get-budget-pacing.usecase';

type CampaignRow = {
  campaignId: string;
  campaignName: string;
  platform: string;
  currency: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  adSetDailyBudgets: Array<number | null>;
};

const campaign = (
  overrides: Partial<CampaignRow> & { campaignId: string },
): CampaignRow => ({
  campaignName: `Campanha ${overrides.campaignId}`,
  platform: 'META',
  currency: 'USD',
  dailyBudget: null,
  lifetimeBudget: null,
  adSetDailyBudgets: [],
  ...overrides,
});

const spendRow = {
  campaignId: 'with-budget',
  spendBase: 5500,
  date: new Date(),
  baseCurrency: 'BRL',
};

function buildHarness({
  campaigns,
  rateAvailable,
  rows = [spendRow],
  organizationBaseCurrency = 'BRL',
}: {
  campaigns: CampaignRow[];
  /** `false` reproduz `fx_rates` sem cotação para a data. */
  rateAvailable: boolean;
  rows?: Array<typeof spendRow>;
  organizationBaseCurrency?: string | null;
}) {
  const snapshots = { query: jest.fn().mockResolvedValue(rows) };
  const budgets = {
    listActiveWithBudgets: jest.fn().mockResolvedValue(campaigns),
    organizationBaseCurrency: jest
      .fn()
      .mockResolvedValue(organizationBaseCurrency),
  };
  const currency = {
    normalize: jest.fn(({ amount }: { amount: number }) =>
      Promise.resolve(
        rateAvailable
          ? { valueBase: amount * 5.5, normalizationPending: false }
          : { valueBase: 0, normalizationPending: true },
      ),
    ),
  };
  const scope = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ accountId: 'account-1', organizationId: 'org-1' }),
  };

  return new GetBudgetPacingUseCase(
    snapshots as never,
    budgets as never,
    currency as never,
    scope as never,
  );
}

describe('GetBudgetPacingUseCase', () => {
  const campaigns = [
    campaign({ campaignId: 'with-budget', dailyBudget: 500 }),
    campaign({ campaignId: 'lifetime-only', lifetimeBudget: 9000 }),
  ];

  it('teto declarado sem câmbio conta como sem taxa, NÃO como sem orçamento diário', async () => {
    // Era o defeito: a campanha entrava em `excludedWithoutRate` e, chegando
    // com `dailyBudgetBase: null`, era contada de novo como sem teto — a tela
    // afirmava que nenhuma campanha declara orçamento diário.
    const useCase = buildHarness({ campaigns, rateAvailable: false });

    const result = await useCase.execute('account-1', { period: '30d' });

    expect(result.data).toMatchObject({
      excludedWithoutRate: 1,
      excludedWithoutDailyBudget: 1,
      rows: [],
    });
  });

  it('com câmbio, o teto entra convertido para a moeda-base', async () => {
    const useCase = buildHarness({ campaigns, rateAvailable: true });

    const result = await useCase.execute('account-1', { period: '30d' });

    expect(result.data).toMatchObject({
      excludedWithoutRate: 0,
      excludedWithoutDailyBudget: 1,
      rows: [{ campaignId: 'with-budget', dailyBudgetBase: 2750 }],
    });
  });

  it('janela sem gasto usa a moeda-base da organização, e não acusa falta de câmbio', async () => {
    // Sem linha de série não há de onde ler a unidade. Cair em `null` mandava
    // todo teto para `excludedWithoutRate` — "sem cotação" onde só faltava gasto.
    const useCase = buildHarness({
      campaigns,
      rateAvailable: true,
      rows: [],
    });

    const result = await useCase.execute('account-1', { period: '30d' });

    expect(result.data).toMatchObject({
      baseCurrency: 'BRL',
      excludedWithoutRate: 0,
      rows: [
        { campaignId: 'with-budget', dailyBudgetBase: 2750, spendBase: 0 },
      ],
    });
  });
});
