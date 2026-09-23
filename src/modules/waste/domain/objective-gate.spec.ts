import {
  conversionTarget,
  nonConversionTarget,
  UNKNOWN_OPTIMIZATION,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { buildBaseline } from './baseline';
import { DEFAULT_DETECTOR_PROFILE } from './detector-profile';
import {
  budgetStarvationDetector,
  highCpaDetector,
  lowCtrDetector,
  runAdDetector,
  zeroConversionsDetector,
} from './detectors';
import { natureOf } from './evidence-gaps';
import { aggregate, daily, score } from './test-support/aggregate.fixture';
import type { AdWindowAggregate, DetectionContext } from './detection-context';

/**
 * O portão de objetivo — o defeito que ele fecha é o falso positivo mais caro
 * do catálogo: anúncio de lead, alcance ou tráfego com zero conversões recebendo
 * `ZERO_CONVERSIONS` e, com ele, recomendação de pausa.
 */

const GATE = { maturityGatingEnabled: true };

function contextFor(
  ad: AdWindowAggregate,
  peers: AdWindowAggregate[] = [],
  baselineAds: AdWindowAggregate[] = [ad, ...peers],
): DetectionContext {
  return {
    ad,
    adSetPeers: peers,
    accountBaseline: buildBaseline(baselineAds),
    score: score({}, 80),
    windowDays: 14,
    profile: DEFAULT_DETECTOR_PROFILE,
  };
}

/** R$ 140 em 14 dias, nenhuma conversão, janela madura. */
const spendingWithoutConversions = (
  optimization = conversionTarget('PURCHASE'),
) => aggregate({ optimization });

describe('portão de objetivo', () => {
  it('anúncio de lead sem lead é desperdício — o evento do conjunto é a conversão', () => {
    const result = runAdDetector(
      zeroConversionsDetector,
      contextFor(spendingWithoutConversions(conversionTarget('LEAD'))),
      GATE,
    );
    expect(result.finding?.type).toBe('ZERO_CONVERSIONS');
  });

  it.each(['AWARENESS', 'TRAFFIC', 'ENGAGEMENT'] as const)(
    'anúncio de %s não recebe ZERO_CONVERSIONS, e o motivo é declarado',
    (cls) => {
      const result = runAdDetector(
        zeroConversionsDetector,
        contextFor(spendingWithoutConversions(nonConversionTarget(cls))),
        GATE,
      );
      expect(result.finding).toBeNull();
      expect(result.insufficiency?.code).toBe('OBJECTIVE_NOT_CONVERSION');
      expect(natureOf(result.insufficiency!.code)).toBe('NOT_APPLICABLE');
    },
  );

  it('objetivo desconhecido não é julgado por conversão', () => {
    const result = runAdDetector(
      zeroConversionsDetector,
      contextFor(spendingWithoutConversions(UNKNOWN_OPTIMIZATION)),
      GATE,
    );
    expect(result.finding).toBeNull();
    expect(result.insufficiency?.code).toBe('OBJECTIVE_UNKNOWN');
  });

  it('evento que a plataforma não separa não é contado', () => {
    const result = runAdDetector(
      zeroConversionsDetector,
      contextFor(spendingWithoutConversions(conversionTarget('OTHER', false))),
      GATE,
    );
    expect(result.finding).toBeNull();
    expect(result.insufficiency?.code).toBe('CONVERSION_NOT_MEASURABLE');
  });

  it('detectores de entrega continuam valendo para qualquer objetivo', () => {
    const peers = [1, 2, 3].map((index) =>
      aggregate({
        adId: `peer-${index}`,
        optimization: nonConversionTarget('TRAFFIC'),
        daily: daily(14, { clicks: 40 }),
      }),
    );
    const weak = aggregate({
      optimization: nonConversionTarget('TRAFFIC'),
      daily: daily(14, { clicks: 2 }),
    });

    const result = runAdDetector(lowCtrDetector, contextFor(weak, peers), GATE);
    expect(result.finding?.type).toBe('LOW_CTR');
  });
});

describe('sem anúncio comparável (NO_BENCHMARK)', () => {
  it('CPA alto sem pares nem linha de base declara o motivo em vez de calar', () => {
    const converting = aggregate({
      daily: daily(14, { conversions: 1 }),
    });

    const result = runAdDetector(
      highCpaDetector,
      contextFor(converting, [], [converting]),
      GATE,
    );

    expect(result.finding).toBeNull();
    expect(result.insufficiency).toMatchObject({
      code: 'NO_BENCHMARK',
      current: 1,
      required: 3,
    });
    expect(natureOf('NO_BENCHMARK')).toBe('STRUCTURAL');
  });

  it('oportunidade exige pares no mesmo conjunto, sem queda para a conta', () => {
    const peer = aggregate({ adId: 'peer-1' });
    const result = runAdDetector(
      budgetStarvationDetector,
      contextFor(aggregate(), [peer], [aggregate(), peer, peer, peer]),
      GATE,
    );
    expect(result.insufficiency).toMatchObject({
      code: 'NO_BENCHMARK',
      current: 1,
    });
  });
});
