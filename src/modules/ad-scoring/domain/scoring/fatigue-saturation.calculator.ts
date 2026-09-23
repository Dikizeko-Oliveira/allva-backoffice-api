import { clamp, isPresent, normalize, weightedAverage } from './score-math';
import { CreativeAggregate } from './score-types';

/**
 * Preserves the legacy `fatigueScore` (0..1) contract used by the original
 * insights endpoint while letting us factor in more nuanced signals than the
 * original `freq > 3 && ctr < 1 ? 0.8 : 0.2` heuristic.
 *
 * The output is intentionally 0..1 (not 0..100) so existing consumers keep
 * working unchanged.
 */
export class FatigueSaturationCalculator {
  /** Per-creative fatigue (0..1). Higher = more fatigued. */
  static fatigueScore(aggregate: CreativeAggregate): number {
    const { averages } = aggregate;

    const freqPart = normalize(averages.frequency, 2.5, 6.0);
    const ctrPart = normalize(
      averages.ctr === null ? null : -averages.ctr,
      -3.0,
      -0.3,
    );

    const composite = weightedAverage([
      { value: freqPart, weight: 0.6 },
      { value: ctrPart, weight: 0.4 },
    ]);

    if (composite === null) return 0.2;
    return clamp(composite, 0, 1);
  }

  /**
   * Portfolio-level saturation risk (0..1). Original definition kept (% of
   * creatives flagged as fatigued) but accepts a typed array so callers no
   * longer pass anonymous shapes.
   */
  static portfolioSaturationRisk(
    items: Array<{ fatigueScore: number }>,
  ): number {
    if (items.length === 0) return 0;
    const flagged = items.filter((c) => c.fatigueScore > 0.5).length;
    return clamp(flagged / items.length, 0, 1);
  }
}

/** Helper: per-day CPM, exposed for tests / debug. */
export function dailyCpm(spend: number, impressions: number): number | null {
  if (!isPresent(spend) || !isPresent(impressions) || impressions <= 0) {
    return null;
  }
  return (spend / impressions) * 1000;
}
