import { conversionTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import {
  estimateReadiness,
  summarizeEvidenceGaps,
  type SlicedInsufficiency,
} from './evidence-gaps';
import { aggregate, daily } from './test-support/aggregate.fixture';

const NOW = new Date('2026-09-22T12:00:00.000Z');

function recusal(overrides: Partial<SlicedInsufficiency>): SlicedInsufficiency {
  return {
    adId: 'ad-1',
    type: 'HIGH_CPA',
    sufficiency: 'INSUFFICIENT',
    code: 'AWAITING_DAYS',
    reason: 'x',
    lagDays: 0,
    ...overrides,
  };
}

/** 10 por dia de gasto, 1.000 impressões, 20 cliques. */
const recent = aggregate({
  daily: daily(14, {}, new Date('2026-09-08T00:00:00.000Z')),
});

describe('summarizeEvidenceGaps', () => {
  it('agrupa detectores que esperam o mesmo motivo e o mesmo mínimo', () => {
    const gaps = summarizeEvidenceGaps({
      insufficiencies: [
        recusal({ type: 'CREATIVE_FATIGUE', current: 3, required: 7 }),
        recusal({ type: 'LEARNING_INSTABILITY', current: 3, required: 7 }),
        recusal({ type: 'LOW_CTR', current: 3, required: 3 }),
      ],
      recent,
      firstObservedOn: new Date('2026-09-19T00:00:00.000Z'),
      windowDays: 14,
      now: NOW,
    });

    expect(gaps).toHaveLength(2);
    expect(gaps[0].detectorTypes).toEqual(['LOW_CTR']);
    expect(gaps[1].detectorTypes).toEqual([
      'CREATIVE_FATIGUE',
      'LEARNING_INSTABILITY',
    ]);
    expect(gaps[1].reason).toBe('3 de 7 dias de série na janela analisada.');
  });

  it('ordena: esperando dado, depois estrutural, depois não se aplica', () => {
    const gaps = summarizeEvidenceGaps({
      insufficiencies: [
        recusal({ code: 'OBJECTIVE_NOT_CONVERSION', type: 'ZERO_CONVERSIONS' }),
        recusal({
          code: 'NO_BENCHMARK',
          type: 'LOW_CTR',
          current: 1,
          required: 3,
        }),
        recusal({ code: 'AWAITING_DAYS', current: 1, required: 3 }),
      ],
      recent,
      firstObservedOn: null,
      windowDays: 14,
      now: NOW,
    });

    expect(gaps.map((gap) => gap.nature)).toEqual([
      'AWAITING',
      'STRUCTURAL',
      'NOT_APPLICABLE',
    ]);
  });

  it('o mesmo motivo vindo de recortes diferentes vira uma linha, com a data mais distante', () => {
    const gaps = summarizeEvidenceGaps({
      insufficiencies: [
        recusal({ type: 'LOW_CTR', current: 1, required: 3, lagDays: 0 }),
        recusal({ type: 'HIGH_CPA', current: 1, required: 3, lagDays: 14 }),
      ],
      recent,
      firstObservedOn: new Date('2026-09-21T00:00:00.000Z'),
      windowDays: 14,
      now: NOW,
    });

    expect(gaps).toHaveLength(1);
    expect(gaps[0].detectorTypes).toEqual(['HIGH_CPA', 'LOW_CTR']);
    // Recorte defasado: o primeiro dia (21/09) só entra na janela julgada 14
    // dias depois; faltam 2 dias a partir daí.
    expect(gaps[0].estimatedReadyOn).toBe('2026-10-07');
  });

  it('usa o evento de conversão do anúncio na frase', () => {
    const [gap] = summarizeEvidenceGaps({
      insufficiencies: [
        recusal({ code: 'AWAITING_CONVERSIONS', current: 1, required: 3 }),
      ],
      recent: aggregate({ optimization: conversionTarget('LEAD') }),
      firstObservedOn: null,
      windowDays: 14,
      now: NOW,
    });
    expect(gap.reason).toBe('1 de 3 conversões (lead) na janela.');
  });
});

describe('estimateReadiness', () => {
  const base = {
    lagDays: 0,
    recent,
    firstObservedOn: null,
    windowDays: 14,
    now: NOW,
  };

  it('dias faltantes a partir de hoje, no recorte corrente', () => {
    expect(
      estimateReadiness({
        ...base,
        code: 'AWAITING_DAYS',
        current: 4,
        required: 7,
      }).readyOn,
    ).toBe('2026-09-25');
  });

  it('gasto faltante pelo ritmo recente', () => {
    // Faltam 30 a 10 por dia: três dias.
    expect(
      estimateReadiness({
        ...base,
        code: 'AWAITING_SPEND',
        current: 20,
        required: 50,
      }).readyOn,
    ).toBe('2026-09-25');
  });

  it('no ritmo atual, a janela que desliza nunca junta o mínimo', () => {
    // 10 por dia × 14 dias = 140 < 500.
    expect(
      estimateReadiness({
        ...base,
        code: 'AWAITING_SPEND',
        current: 100,
        required: 500,
      }),
    ).toEqual({ readyOn: null, unreachable: true });
  });

  it('sem conversão recente não há ritmo, e não há data', () => {
    expect(
      estimateReadiness({
        ...base,
        code: 'AWAITING_CONVERSIONS',
        current: 0,
        required: 3,
      }),
    ).toEqual({ readyOn: null, unreachable: false });
  });

  it('anúncio pausado não acumula evidência', () => {
    expect(
      estimateReadiness({
        ...base,
        recent: aggregate({ isDelivering: false }),
        code: 'AWAITING_DAYS',
        current: 1,
        required: 3,
      }).readyOn,
    ).toBeNull();
  });

  it('score sai no ciclo seguinte', () => {
    expect(
      estimateReadiness({
        ...base,
        code: 'AWAITING_SCORE',
        current: null,
        required: null,
      }).readyOn,
    ).toBe('2026-09-23');
  });

  it('motivo estrutural ou que não se aplica não tem data', () => {
    for (const code of ['NO_BENCHMARK', 'OBJECTIVE_NOT_CONVERSION'] as const) {
      expect(
        estimateReadiness({ ...base, code, current: 1, required: 3 }).readyOn,
      ).toBeNull();
    }
  });
});
