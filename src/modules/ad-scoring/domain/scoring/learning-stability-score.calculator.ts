import {
  clamp,
  coefficientOfVariation,
  computeConfidence,
  invertedNormalize,
  isPresent,
  weightedAverage,
} from './score-math';
import { CreativeAggregate, ScoreResult } from './score-types';

/**
 * Learning Stability Score (0-100). HIGHER = more stable / well-learned.
 *
 * Signals: day-to-day coefficient of variation (CV) for CPA, CTR and spend,
 * plus a coverage factor (how many days actually had spend in the window).
 *
 * - Low CV across days suggests delivery is past the learning phase and the
 *   algorithm has converged.
 * - Low coverage (e.g. 2 of 14 days had spend) downscales the score because
 *   the sample is too sparse to call it "stable".
 *
 * Notes on what we deliberately DO NOT do:
 * - No detection of platform-level "learning resets" (would need provider
 *   events we don't sync today).
 * - No Markov/causal modelling — pure descriptive statistics only.
 */

const ANCHORS = {
  cpaCv: { low: 0.15, high: 0.9 },
  ctrCv: { low: 0.1, high: 0.7 },
  spendCv: { low: 0.1, high: 1.0 },
};

const WEIGHTS = {
  cpaCv: 0.4,
  ctrCv: 0.35,
  spendCv: 0.25,
};

const MIN_DAYS_FOR_FULL_CONFIDENCE = 7;

export class LearningStabilityScoreCalculator {
  static calculate(aggregate: CreativeAggregate): ScoreResult {
    const { daily, totals, days } = aggregate;

    const cpaSamples = daily
      .filter((d) => d.conversions > 0 && d.spend > 0)
      .map((d) => d.spend / d.conversions);
    const ctrSamples = daily
      .filter((d) => isPresent(d.ctr))
      .map((d) => d.ctr as number);
    const spendSamples = daily.filter((d) => d.spend > 0).map((d) => d.spend);

    const cpaCv = coefficientOfVariation(cpaSamples);
    const ctrCv = coefficientOfVariation(ctrSamples);
    const spendCv = coefficientOfVariation(spendSamples);

    // Lower CV → more stable, so we invert.
    const cpaSignal = invertedNormalize(
      cpaCv,
      ANCHORS.cpaCv.low,
      ANCHORS.cpaCv.high,
    );
    const ctrSignal = invertedNormalize(
      ctrCv,
      ANCHORS.ctrCv.low,
      ANCHORS.ctrCv.high,
    );
    const spendSignal = invertedNormalize(
      spendCv,
      ANCHORS.spendCv.low,
      ANCHORS.spendCv.high,
    );

    const composite = weightedAverage([
      { value: cpaSignal, weight: WEIGHTS.cpaCv },
      { value: ctrSignal, weight: WEIGHTS.ctrCv },
      { value: spendSignal, weight: WEIGHTS.spendCv },
    ]);

    // Coverage factor: fraction of window with non-zero spend, with a floor
    // so single-day samples cannot claim full stability.
    const activeDays = spendSamples.length;
    const coverage = days > 0 ? clamp(activeDays / Math.max(days, 1), 0, 1) : 0;
    const coverageFactor = clamp(
      activeDays / MIN_DAYS_FOR_FULL_CONFIDENCE,
      0,
      1,
    );

    // Fallback: no usable samples → neutral 50 with low confidence.
    let value: number;
    if (composite === null) {
      value = 50;
    } else {
      value = composite * 100 * (0.5 + 0.5 * coverageFactor);
    }

    const present = [cpaSignal, ctrSignal, spendSignal].filter(
      (s) => s !== null,
    ).length;

    const confidence = computeConfidence({
      presentSignals: present,
      expectedSignals: 3,
      impressions: totals.impressions,
      volumeAt: 5000,
    });

    const reasons: string[] = [];
    if (cpaSignal !== null && cpaSignal < 0.3)
      reasons.push('CPA volátil entre os dias');
    if (ctrSignal !== null && ctrSignal < 0.3)
      reasons.push('CTR oscilando dia-a-dia');
    if (spendSignal !== null && spendSignal < 0.3)
      reasons.push('Entrega/spend inconsistente');
    if (activeDays < 3) reasons.push('Poucos dias com entrega para concluir');

    return {
      value: Math.round(clamp(value, 0, 100)),
      confidence: confidence * (0.6 + 0.4 * coverage),
      signals: {
        cpaCv: cpaCv,
        ctrCv: ctrCv,
        spendCv: spendCv,
        coverage,
      },
      reasons,
    };
  }
}
