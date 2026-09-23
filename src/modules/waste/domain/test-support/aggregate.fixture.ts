import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import { conversionTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { AdWindowAggregate, DailyPoint } from '../detection-context';

/**
 * Construtores de contexto para os testes de detector.
 *
 * Existem para que cada teste declare **só o que a sua fronteira exige** — um
 * teste de `LOW_CTR` não deve ter de inventar receita, e um de `HIGH_CPA` não
 * deve ter de inventar frequência. Sem isso, cada asserção carrega vinte campos
 * irrelevantes e o leitor perde qual deles é o ponto.
 */

const DAY = 24 * 60 * 60 * 1000;

export function daily(
  days: number,
  overrides: Partial<DailyPoint> = {},
  startingAt = new Date('2026-07-01T00:00:00.000Z'),
): DailyPoint[] {
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(startingAt.getTime() + index * DAY),
    spend: 10,
    revenue: 0,
    spendBase: 10,
    revenueBase: 0,
    impressions: 1_000,
    clicks: 20,
    conversions: 0,
    frequency: null,
    ...overrides,
  }));
}

export function aggregate(
  overrides: Partial<AdWindowAggregate> = {},
): AdWindowAggregate {
  const points = overrides.daily ?? daily(14);

  const totals = points.reduce(
    (sum, point) => ({
      spend: sum.spend + point.spend,
      spendBase: sum.spendBase + point.spendBase,
      revenue: sum.revenue + point.revenue,
      revenueBase: sum.revenueBase + point.revenueBase,
      impressions: sum.impressions + point.impressions,
      clicks: sum.clicks + point.clicks,
      conversions: sum.conversions + point.conversions,
    }),
    {
      spend: 0,
      spendBase: 0,
      revenue: 0,
      revenueBase: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    },
  );

  return {
    adId: 'ad-1',
    adSetId: 'set-1',
    unitKind: 'AD',
    campaignId: 'campaign-1',
    adAccountId: 'account-1',
    platform: 'META',
    creativeId: 'creative-1',
    contentHash: null,
    isDelivering: true,
    // O padrão dos testes é o anúncio de venda: conversão por compra, contável.
    // Testes do portão de objetivo sobrescrevem.
    optimization: conversionTarget('PURCHASE'),
    currency: 'BRL',
    baseCurrency: 'BRL',
    daily: points,
    days: points.length,
    ...totals,
    ctr:
      totals.impressions > 0
        ? (totals.clicks / totals.impressions) * 100
        : null,
    cpa: totals.conversions > 0 ? totals.spendBase / totals.conversions : null,
    roas: totals.spendBase > 0 ? totals.revenueBase / totals.spendBase : null,
    dataMaturity: 'MATURE',
    hasValidObservation: true,
    excludedByNormalization: 0,
    ...overrides,
  };
}

/** Um score com os componentes disponíveis, na escala nativa de §12.2. */
export function score(
  components: Partial<
    Record<'fatigue' | 'negativeFeedbackRisk' | 'learningStability', number>
  > = {},
  aiScore = 50,
): AdScoreView {
  const build = (value: number | undefined) => ({
    value: value ?? null,
    normalizedValue: value ?? null,
    available: value !== undefined,
    confidence: 0.8,
    reasons: [],
  });

  return {
    adId: 'ad-1',
    adScoreId: 'score-1',
    aiScore,
    aiConfidence: 0.8,
    componentCoverage: 1,
    coverageRatio: 1,
    algoVersion: 'deterministic-v2',
    scoreDate: new Date('2026-07-14T00:00:00.000Z'),
    scoredAt: new Date('2026-07-14T05:30:00.000Z'),
    windowDays: 14,
    delta7d: null,
    seriesDiscontinuity: null,
    frozenAt: null,
    components: {
      attention: build(undefined),
      audienceFit: build(undefined),
      fatigue: build(components.fatigue),
      negativeFeedbackRisk: build(components.negativeFeedbackRisk),
      learningStability: build(components.learningStability),
    },
    context: null,
    narrative: null,
  };
}
