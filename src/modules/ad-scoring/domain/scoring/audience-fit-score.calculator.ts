import {
  clamp,
  coefficientOfVariation,
  computeConfidence,
  isPresent,
  normalize,
  weightedAverage,
} from './score-math';
import {
  CreativeAggregate,
  PortfolioBenchmarks,
  ScoreResult,
} from './score-types';

/**
 * Audience Fit Score (0-100): how well the creative resonates with the
 * audience it is being delivered to, judged by efficiency + consistency.
 *
 * Signals:
 * - Conversion rate (heavy): clearest signal of audience alignment.
 * - ROAS (heavy): commercial fit.
 * - CTR (medium): top-of-funnel resonance.
 * - CPA relative to portfolio (medium): efficiency vs peers.
 * - CTR consistency over days (light): delivery quality / steady fit.
 *
 * v1 is fully rule-based. The shape (signals[]) is preserved so an AI
 * enrichment pass can later refine `value` or `reasons` without changing
 * the contract.
 */

const ANCHORS = {
  ctr: { low: 0.5, high: 3.0 }, // %
  conversionRate: { low: 0.005, high: 0.05 }, // fraction
  roas: { low: 0.8, high: 3.0 }, // x
  cpaEfficiency: { low: 2.0, high: 0.5 }, // ratio vs portfolio (inverted band)
  retentionConsistency: { low: 0.5, high: 0.1 }, // cv (inverted band)
};

const WEIGHTS = {
  ctr: 0.18,
  conversionRate: 0.28,
  roas: 0.28,
  cpaEfficiency: 0.16,
  retentionConsistency: 0.1,
};

export class AudienceFitScoreCalculator {
  static calculate(
    aggregate: CreativeAggregate,
    benchmarks?: PortfolioBenchmarks,
  ): ScoreResult {
    const { averages, totals, daily } = aggregate;

    const ctrSignal = normalize(
      averages.ctr,
      ANCHORS.ctr.low,
      ANCHORS.ctr.high,
    );
    const convRateSignal = normalize(
      averages.conversionRate,
      ANCHORS.conversionRate.low,
      ANCHORS.conversionRate.high,
    );
    const roasSignal = normalize(
      averages.roas,
      ANCHORS.roas.low,
      ANCHORS.roas.high,
    );

    // CPA efficiency: ratio vs portfolio avg, inverted band so lower-than-avg
    // (more efficient) maps to higher score.
    let cpaEfficiencySignal: number | null = null;
    if (
      isPresent(averages.cpa) &&
      benchmarks?.avgCpa &&
      benchmarks.avgCpa > 0
    ) {
      const ratio = averages.cpa / benchmarks.avgCpa;
      cpaEfficiencySignal = normalize(
        ratio,
        ANCHORS.cpaEfficiency.low,
        ANCHORS.cpaEfficiency.high,
      );
    }

    // Retention consistency: low coefficient of variation in daily CTR
    // suggests stable resonance.
    const dailyCtrs = daily
      .filter((d) => isPresent(d.ctr))
      .map((d) => d.ctr as number);
    let retentionSignal: number | null = null;
    if (dailyCtrs.length >= 3) {
      const cv = coefficientOfVariation(dailyCtrs);
      if (cv !== null) {
        retentionSignal = normalize(
          cv,
          ANCHORS.retentionConsistency.low,
          ANCHORS.retentionConsistency.high,
        );
      }
    }

    const composite = weightedAverage([
      { value: ctrSignal, weight: WEIGHTS.ctr },
      { value: convRateSignal, weight: WEIGHTS.conversionRate },
      { value: roasSignal, weight: WEIGHTS.roas },
      { value: cpaEfficiencySignal, weight: WEIGHTS.cpaEfficiency },
      { value: retentionSignal, weight: WEIGHTS.retentionConsistency },
    ]);

    // Fallback: with no signals we cannot assess fit; emit neutral with low
    // confidence so the UI can hide / dim it.
    const value = composite === null ? 50 : composite * 100;

    const present = [
      ctrSignal,
      convRateSignal,
      roasSignal,
      cpaEfficiencySignal,
      retentionSignal,
    ].filter((s) => s !== null).length;

    const confidence = computeConfidence({
      presentSignals: present,
      expectedSignals: 5,
      impressions: totals.impressions,
      volumeAt: 5000,
    });

    const reasons: string[] = [];
    if (convRateSignal !== null && convRateSignal < 0.3)
      reasons.push('Taxa de conversão fraca para a audiência');
    if (roasSignal !== null && roasSignal < 0.3)
      reasons.push('ROAS abaixo do esperado');
    if (cpaEfficiencySignal !== null && cpaEfficiencySignal < 0.3)
      reasons.push('CPA acima da média do portfólio');
    if (retentionSignal !== null && retentionSignal < 0.3)
      reasons.push('Performance instável dia-a-dia');
    if (ctrSignal !== null && ctrSignal < 0.25)
      reasons.push('CTR sugere baixa ressonância de topo de funil');

    return {
      value: Math.round(clamp(value, 0, 100)),
      confidence,
      signals: {
        ctr: ctrSignal,
        conversionRate: convRateSignal,
        roas: roasSignal,
        cpaEfficiency: cpaEfficiencySignal,
        retentionConsistency: retentionSignal,
      },
      reasons,
    };
  }
}
