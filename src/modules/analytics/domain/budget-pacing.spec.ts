import {
  computePacing,
  resolveDailyBudget,
  statusOf,
  PACING_TOLERANCE,
} from './budget-pacing';

describe('resolveDailyBudget — CBO e a dupla contagem', () => {
  it('usa o orçamento da campanha quando ele existe (CBO)', () => {
    const resolved = resolveDailyBudget({
      campaignDailyBudget: 500,
      adSetDailyBudgets: [null, null],
    });

    expect(resolved).toBe(500);
  });

  it('soma os conjuntos quando a campanha não tem orçamento', () => {
    const resolved = resolveDailyBudget({
      campaignDailyBudget: null,
      adSetDailyBudgets: [200, 300],
    });

    expect(resolved).toBe(500);
  });

  /**
   * O caso que dobraria o teto. Se os dois níveis vierem preenchidos — o que
   * acontece quando a plataforma reporta o herdado no conjunto —, somar daria
   * 1000 e o painel diria que sobra orçamento numa conta que está estourando.
   */
  it('NÃO soma os dois níveis quando ambos vêm preenchidos', () => {
    const resolved = resolveDailyBudget({
      campaignDailyBudget: 500,
      adSetDailyBudgets: [200, 300],
    });

    expect(resolved).toBe(500);
  });

  it('devolve null quando não há orçamento diário em nenhum nível', () => {
    expect(
      resolveDailyBudget({
        campaignDailyBudget: null,
        adSetDailyBudgets: [null],
      }),
    ).toBeNull();
  });

  it('ignora zero, que não é orçamento', () => {
    expect(
      resolveDailyBudget({
        campaignDailyBudget: 0,
        adSetDailyBudgets: [0, 0],
      }),
    ).toBeNull();
  });
});

describe('statusOf — a faixa de tolerância', () => {
  it('gasto no ritmo é HEALTHY', () => {
    expect(statusOf(100, 100)).toBe('HEALTHY');
  });

  it('oscilação dentro da tolerância não vira desvio', () => {
    const withinBand = 100 * (1 + PACING_TOLERANCE - 0.01);
    expect(statusOf(withinBand, 100)).toBe('HEALTHY');
  });

  it('acima da tolerância é OVERSPENDING', () => {
    expect(statusOf(120, 100)).toBe('OVERSPENDING');
  });

  it('abaixo da tolerância é UNDERSPENDING', () => {
    expect(statusOf(80, 100)).toBe('UNDERSPENDING');
  });

  /** Sem esperado não há régua: chamar de estouro seria inventar o denominador. */
  it('sem gasto esperado é HEALTHY, não OVERSPENDING', () => {
    expect(statusOf(50, 0)).toBe('HEALTHY');
  });
});

describe('computePacing', () => {
  const campaign = (
    id: string,
    dailyBudgetBase: number | null,
    spendBase: number,
  ) => ({
    campaignId: id,
    campaignName: `Campanha ${id}`,
    platform: 'META',
    dailyBudgetBase,
    spendBase,
  });

  it('compara o gasto com o esperado para os dias DECORRIDOS', () => {
    // 100/dia × 10 dias decorridos = 1000 esperados. Gastou 1000 ⇒ no ritmo.
    const result = computePacing({
      campaigns: [campaign('a', 100, 1000)],
      elapsedDays: 10,
      periodDays: 30,
      dailySpend: [],
    });

    expect(result.expectedSpendBase).toBe(1000);
    expect(result.status).toBe('HEALTHY');
    // O orçamento do período inteiro é outro número, e não é o da comparação.
    expect(result.budgetBase).toBe(3000);
  });

  it('conta as campanhas sem orçamento diário em vez de somá-las como zero', () => {
    const result = computePacing({
      campaigns: [campaign('a', 100, 500), campaign('b', null, 900)],
      elapsedDays: 5,
      periodDays: 30,
      dailySpend: [],
    });

    expect(result.excludedWithoutDailyBudget).toBe(1);
    // O gasto da campanha sem orçamento não entra: ele não tem régua contra a
    // qual ser lido, e somá-lo faria a conta inteira parecer em estouro.
    expect(result.spendBase).toBe(500);
    expect(result.rows).toHaveLength(1);
  });

  it('apura o ritmo observado sobre os dias decorridos', () => {
    const result = computePacing({
      campaigns: [campaign('a', 100, 600)],
      elapsedDays: 6,
      periodDays: 30,
      dailySpend: [],
    });

    expect(result.burnRateBase).toBe(100);
  });

  /** Sem dia decorrido não há de onde tirar média — `0` é o único honesto. */
  it('não divide por zero quando nenhum dia decorreu', () => {
    const result = computePacing({
      campaigns: [campaign('a', 100, 0)],
      elapsedDays: 0,
      periodDays: 30,
      dailySpend: [],
    });

    expect(result.burnRateBase).toBe(0);
    expect(result.expectedSpendBase).toBe(0);
  });

  it('leva o teto diário para cada ponto da série', () => {
    const result = computePacing({
      campaigns: [campaign('a', 100, 200), campaign('b', 50, 100)],
      elapsedDays: 2,
      periodDays: 30,
      dailySpend: [
        { date: '2026-08-01', spendBase: 180 },
        { date: '2026-08-02', spendBase: 120 },
      ],
    });

    expect(result.timeseries).toEqual([
      { date: '2026-08-01', spendBase: 180, allowedBase: 150 },
      { date: '2026-08-02', spendBase: 120, allowedBase: 150 },
    ]);
  });

  it('ordena as linhas pelo gasto, do maior para o menor', () => {
    const result = computePacing({
      campaigns: [campaign('a', 100, 200), campaign('b', 100, 900)],
      elapsedDays: 5,
      periodDays: 30,
      dailySpend: [],
    });

    expect(result.rows.map((row) => row.campaignId)).toEqual(['b', 'a']);
  });
});
