import {
  clamp,
  computeConfidence,
  invertedNormalize,
  normalize,
  weightedAverage,
} from './score-math';
import { CreativeAggregate, ScoreResult } from './score-types';

/**
 * Attention Score (0-100): potential to capture and retain initial attention.
 *
 * Signals & rationale:
 * - CTR (heavy weight): direct expression of click-through intent.
 * - Thumbstop rate (Meta video): proxy of "stop the scroll".
 * - Hold rate (Meta video): early retention.
 * - Engagement rate (engagement / impressions): light-touch interest.
 * - CPC (inverse): cheaper clicks → more efficient attention capture.
 * - CPM (inverse): low CPM at decent CTR suggests delivery quality.
 *
 * Anchor ranges below come from industry common bands observed across
 * Meta/Google/TikTok ads. They are deliberately broad to keep the
 * normalisation robust against absolute drift across verticals.
 */

const ANCHORS = {
  ctr: { low: 0.3, high: 3.0 }, // %
  thumbstopRate: { low: 0.1, high: 0.4 }, // fraction
  holdRate: { low: 0.15, high: 0.5 }, // fraction (p100/p25)
  engagementRate: { low: 0.005, high: 0.05 }, // fraction
  cpc: { low: 0.1, high: 5.0 }, // currency
  cpm: { low: 2, high: 40 }, // currency
};

const WEIGHTS = {
  ctr: 0.32,
  thumbstopRate: 0.18,
  holdRate: 0.15,
  engagementRate: 0.1,
  cpc: 0.15,
  cpm: 0.1,
};

export class AttentionScoreCalculator {
  static calculate(aggregate: CreativeAggregate): ScoreResult {
    const { averages, totals } = aggregate;

    const ctrSignal = normalize(
      averages.ctr,
      ANCHORS.ctr.low,
      ANCHORS.ctr.high,
    );
    const thumbstopSignal = normalize(
      averages.thumbstopRate,
      ANCHORS.thumbstopRate.low,
      ANCHORS.thumbstopRate.high,
    );
    const holdSignal = normalize(
      averages.holdRate,
      ANCHORS.holdRate.low,
      ANCHORS.holdRate.high,
    );
    const engagementSignal = normalize(
      averages.engagementRate,
      ANCHORS.engagementRate.low,
      ANCHORS.engagementRate.high,
    );
    const cpcSignal = invertedNormalize(
      averages.cpc,
      ANCHORS.cpc.low,
      ANCHORS.cpc.high,
    );
    const cpmSignal = invertedNormalize(
      averages.cpm,
      ANCHORS.cpm.low,
      ANCHORS.cpm.high,
    );

    const composite = weightedAverage([
      { value: ctrSignal, weight: WEIGHTS.ctr },
      { value: thumbstopSignal, weight: WEIGHTS.thumbstopRate },
      { value: holdSignal, weight: WEIGHTS.holdRate },
      { value: engagementSignal, weight: WEIGHTS.engagementRate },
      { value: cpcSignal, weight: WEIGHTS.cpc },
      { value: cpmSignal, weight: WEIGHTS.cpm },
    ]);

    // Sem nenhum sinal de qualidade não há atenção a medir; 30 é o piso.
    //
    // **A2-S4 removeu daqui um ramo que nunca executava.** A redação anterior era
    // `impressions > 500 ? 40 : 30`, com a intenção declarada de "não punir
    // criativo novo". As duas condições eram mutuamente exclusivas: `composite`
    // só é `null` quando os seis sinais são nulos, e `ctr` só é nulo quando não
    // houve impressão — porque o agregador calcula `clicks / impressions`, que
    // dá **0**, não `null`, quando ninguém clicou. Zero é um sinal. Com
    // impressão, portanto, sempre havia composto, e o `40` era inalcançável.
    //
    // Não foi reescrito para virar alcançável, e a razão é de arquitetura: dar
    // 40 a um anúncio com CTR zero seria inventar evidência dentro da
    // calculadora. Proteger criativo novo é trabalho da **composição** (§12.3),
    // onde o prior neutro ponderado por confiança puxa evidência fraca para o
    // meio da escala — e só lá isso funciona, porque só lá se sabe quantos
    // componentes existem e quanta confiança cada um tem.
    const value = composite === null ? 30 : composite * 100;

    const present = [
      ctrSignal,
      thumbstopSignal,
      holdSignal,
      engagementSignal,
      cpcSignal,
      cpmSignal,
    ].filter((s) => s !== null).length;

    const confidence = computeConfidence({
      presentSignals: present,
      expectedSignals: 6,
      impressions: totals.impressions,
      volumeAt: 5000,
    });

    const reasons: string[] = [];
    if (ctrSignal !== null && ctrSignal < 0.25) reasons.push('CTR baixo');
    if (thumbstopSignal !== null && thumbstopSignal < 0.3)
      reasons.push('Thumbstop fraco (0-3s)');
    if (holdSignal !== null && holdSignal < 0.3)
      reasons.push('Hold rate baixo (retenção inicial)');
    if (cpcSignal !== null && cpcSignal < 0.3) reasons.push('CPC elevado');
    if (cpmSignal !== null && cpmSignal < 0.3) reasons.push('CPM elevado');
    if (
      engagementSignal !== null &&
      engagementSignal < 0.3 &&
      totals.impressions > 1000
    )
      reasons.push('Engajamento baixo');

    return {
      value: Math.round(clamp(value, 0, 100)),
      confidence,
      signals: {
        ctr: ctrSignal,
        thumbstopRate: thumbstopSignal,
        holdRate: holdSignal,
        engagementRate: engagementSignal,
        cpc: cpcSignal,
        cpm: cpmSignal,
      },
      reasons,
    };
  }
}
