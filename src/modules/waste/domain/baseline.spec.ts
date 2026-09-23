import {
  buildBaseline,
  dailyAverageOverLastDays,
  median,
  percentile,
  slope,
} from './baseline';
import { aggregate, daily } from './test-support/aggregate.fixture';

/**
 * §10.3 — **mediana e percentis, nunca média.** Corrige o Apêndice A nº 7.
 */
describe('linha de base', () => {
  it('a mediana ignora o outlier que a média absorveria', () => {
    const cpas = [20, 22, 24, 26, 900];

    expect(median(cpas)).toBe(24);
    // A média é 198,4: com ela, o anúncio de CPA 900 elevaria o próprio
    // benchmark o bastante para deixar de ser detectável. É o mecanismo do
    // achado, não uma preferência estatística.
    const mean = cpas.reduce((sum, value) => sum + value, 0) / cpas.length;
    expect(mean).toBeGreaterThan(190);
  });

  it('amostra vazia devolve null, e null não vira zero', () => {
    // Comparar contra zero faria todo anúncio parecer infinitamente pior que a
    // conta — um benchmark ausente é ausência de comparação, não comparação
    // contra nada.
    expect(percentile([], 50)).toBeNull();
    expect(median([])).toBeNull();
  });

  it('percentis interpolam sobre a amostra ordenada', () => {
    const values = [10, 20, 30, 40, 50];

    expect(percentile(values, 10)).toBeCloseTo(14);
    expect(percentile(values, 25)).toBeCloseTo(20);
    expect(percentile(values, 50)).toBeCloseTo(30);
    expect(percentile(values, 75)).toBeCloseTo(40);
  });

  it('cada grandeza usa a amostra em que ela existe', () => {
    // Um anúncio sem conversão não tem CPA. Incluí-lo como zero faria a mediana
    // de CPA despencar até nenhum anúncio caro ser caro.
    const converting = aggregate({
      adId: 'a',
      daily: daily(7, { conversions: 1, spendBase: 30, spend: 30 }),
    });
    const notConverting = aggregate({ adId: 'b', daily: daily(7) });

    const baseline = buildBaseline([converting, notConverting]);

    expect(baseline.sampleSize).toBe(2);
    expect(baseline.cpa.p50).toBe(30);
  });
});

describe('média diária da janela de 7 dias', () => {
  it('divide pelos dias da janela, não pelos dias observados', () => {
    // R$ 700 num único dia dos últimos sete é R$ 100/dia, não R$ 700/dia — e é a
    // primeira leitura que estima o que se interrompe amanhã.
    const points = daily(7).map((point, index) => ({
      date: point.date,
      value: index === 6 ? 700 : 0,
    }));

    expect(dailyAverageOverLastDays(points, 7)).toBe(100);
  });

  it('série curta usa os dias que existem', () => {
    const points = daily(2).map((point) => ({ date: point.date, value: 50 }));

    expect(dailyAverageOverLastDays(points, 7)).toBe(50);
  });
});

describe('inclinação (DEC-4)', () => {
  it('série crescente tem inclinação positiva', () => {
    expect(slope([3, 3.3, 3.6, 3.9])).toBeGreaterThan(0);
  });

  it('série constante tem inclinação zero — frequência alta não é saturação', () => {
    expect(slope([5, 5, 5, 5])).toBe(0);
  });

  it('menos de dois pontos medidos não sustenta inclinação', () => {
    expect(slope([null, 5, null])).toBeNull();
    expect(slope([])).toBeNull();
  });
});
