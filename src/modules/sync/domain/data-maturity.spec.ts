import {
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  maturityOfDay,
  maturityOfWindow,
  restatementWindowDaysFor,
  satisfiesMaturity,
  MINIMUM_MATURITY_BY_FINDING,
} from './data-maturity';

const NOW = new Date('2026-08-01T12:00:00Z');

function daysAgo(days: number): Date {
  const date = new Date(NOW);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

describe('maturidade do dado (§8.9)', () => {
  it('classifica contra a janela de atribuição da CONTA', () => {
    // Janela de 7: 0–6 imaturo, 7–13 assentando, 14+ maduro.
    expect(maturityOfDay(daysAgo(0), NOW, 7)).toBe('IMMATURE');
    expect(maturityOfDay(daysAgo(6), NOW, 7)).toBe('IMMATURE');
    expect(maturityOfDay(daysAgo(7), NOW, 7)).toBe('SETTLING');
    expect(maturityOfDay(daysAgo(13), NOW, 7)).toBe('SETTLING');
    expect(maturityOfDay(daysAgo(14), NOW, 7)).toBe('MATURE');
  });

  it('uma conta de 28 dias não é tratada como uma de 7', () => {
    // É o achado que motivou `restatementWindowDays` morar em `AdAccount` (⊕3):
    // tratá-las igual perde conversão retroativa sempre nas mesmas condições, o
    // que é indistinguível de desempenho ruim.
    const day = daysAgo(20);

    expect(maturityOfDay(day, NOW, 7)).toBe('MATURE');
    expect(maturityOfDay(day, NOW, 28)).toBe('IMMATURE');
  });

  it('trata data futura como idade zero', () => {
    const tomorrow = new Date(NOW);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Fuso da conta à frente do UTC é comum. O erro cai do lado certo: na
    // dúvida, o dado ainda vai mudar.
    expect(maturityOfDay(tomorrow, NOW, 7)).toBe('IMMATURE');
  });

  it('a maturidade da janela é a do dia mais novo', () => {
    expect(
      maturityOfWindow([daysAgo(30), daysAgo(20), daysAgo(2)], NOW, 7),
    ).toBe('IMMATURE');
  });

  it('sem janela declarada, usa o padrão de 7 dias', () => {
    expect(DEFAULT_ATTRIBUTION_WINDOW_DAYS).toBe(7);
    expect(maturityOfDay(daysAgo(3), NOW)).toBe('IMMATURE');
    expect(maturityOfWindow([daysAgo(30)], NOW)).toBe('MATURE');
  });

  it('janela de zero dias é tratada como 1 — nunca divide o mundo em nada', () => {
    expect(maturityOfDay(daysAgo(0), NOW, 0)).toBe('IMMATURE');
    expect(maturityOfDay(daysAgo(2), NOW, 0)).toBe('MATURE');
  });

  it('sem dia observado não há maturidade a declarar', () => {
    // `IMMATURE` mentiria dizendo que existe algo se assentando.
    expect(maturityOfWindow([], NOW, 7)).toBeNull();
  });
});

describe('gate de maturidade dos detectores (§8.9)', () => {
  it('os três que dependem de conversão exigem MATURE', () => {
    expect(MINIMUM_MATURITY_BY_FINDING.ZERO_CONVERSIONS).toBe('MATURE');
    expect(MINIMUM_MATURITY_BY_FINDING.LOW_ROAS).toBe('MATURE');
    expect(MINIMUM_MATURITY_BY_FINDING.HIGH_CPA).toBe('MATURE');
  });

  it('impressão e clique não são re-declarados, então SETTLING basta', () => {
    expect(MINIMUM_MATURITY_BY_FINDING.LOW_CTR).toBe('SETTLING');
    expect(MINIMUM_MATURITY_BY_FINDING.CREATIVE_FATIGUE).toBe('SETTLING');
  });

  it('janela imatura não satisfaz nenhum piso', () => {
    expect(satisfiesMaturity('IMMATURE', 'SETTLING')).toBe(false);
    expect(satisfiesMaturity('IMMATURE', 'MATURE')).toBe(false);
  });

  it('ausência de maturidade nunca satisfaz — não é o mesmo que MATURE', () => {
    expect(satisfiesMaturity(null, 'SETTLING')).toBe(false);
  });
});

describe('janela de re-declaração', () => {
  it('nunca é menor que a janela de atribuição da conta', () => {
    expect(
      restatementWindowDaysFor({
        attributionWindowDays: 28,
        envMinimumDays: 7,
      }),
    ).toBe(28);
  });

  it('honra o mínimo de ambiente quando a atribuição é curta', () => {
    expect(
      restatementWindowDaysFor({
        attributionWindowDays: 1,
        envMinimumDays: 14,
      }),
    ).toBe(14);
  });

  it('usa o padrão de 7 dias quando a plataforma não expõe a atribuição', () => {
    expect(
      restatementWindowDaysFor({
        attributionWindowDays: null,
        envMinimumDays: 3,
      }),
    ).toBe(7);
  });
});
