import { at, buildEvidence } from '../evidence';
import { MIN_BENCHMARK_SAMPLE, peerScopeOf } from '../benchmark';
import { buildBaseline } from '../baseline';
import { priorityFor } from '../priority';
import { dailySpendOf, round2 } from './amounts';
import type {
  AdScopedDetector,
  DetectionContext,
  Finding,
} from '../detection-context';

const DETECTOR_VERSION = 'v2.0.0';

/**
 * `BUDGET_STARVATION` — o único `OPPORTUNITY` do catálogo (§10.2).
 *
 * Um anúncio saudável sufocado por orçamento é dinheiro que **deixou de ser
 * ganho**, não gasto mal. Os dois compartilham a maquinaria de ciclo de vida e
 * jamais se misturam em agregados — a separação é garantida pela view
 * `open_waste`, e é por isso que este achado nasce com `incurred = 0`: não há
 * gasto errado a contabilizar.
 *
 * **Sem queda para a conta.** §10.5 exige `pares ≥ 3` como evidência mínima, e a
 * exigência é diferente da de DEC-3 por uma razão: a recomendação derivada é
 * `SCALE_WINNING_AD`, a única que **aumenta** gasto. Mandar investir mais com
 * base numa comparação contra outro público é o erro que custa dinheiro de
 * verdade, e é por isso que este é o detector que se cala em vez de degradar.
 */
export const budgetStarvationDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'BUDGET_STARVATION',
  version: DETECTOR_VERSION,
  benchmark: { metric: 'impressions', peersOnly: true },

  detect(ctx: DetectionContext): Finding | null {
    const { ad, score } = ctx;
    if (!score) return null;
    if (!ad.isDelivering) return null;
    if (ctx.adSetPeers.length < MIN_BENCHMARK_SAMPLE) return null;

    const values = ctx.profile.thresholds.BUDGET_STARVATION.values;
    if (score.aiScore < values.minAiScore) return null;

    const peers = buildBaseline(ctx.adSetPeers).impressions;
    const floor = at(peers, values.impressionsPercentile as 10 | 25 | 50 | 75);
    const median = at(peers, 50);

    if (floor === null || median === null || median <= 0) return null;
    if (ad.impressions >= floor) return null;
    if (ad.impressions <= 0) return null;

    // **O potencial é o tamanho da alavanca, não uma projeção de receita.**
    //
    // Multiplicar por ROAS produziria "ganho estimado" — um número que parece
    // medido e não é. §9.7 mantém estimado e realizado separados justamente
    // porque achatá-los é como o produto passa a prometer recuperação. O que
    // este detector afirma é verificável: entregando como os pares medianos,
    // este anúncio absorveria mais tanto por dia.
    const daily = dailySpendOf(ad);
    const headroom = Math.min(median / ad.impressions - 1, 3);

    return {
      adId: ad.adId,
      type: 'BUDGET_STARVATION',
      kind: 'OPPORTUNITY',
      priority: priorityFor({
        avoidableDailyBase: round2(daily.valueBase * headroom),
        dailySpendBase: daily.valueBase,
        sufficiency: 'SUFFICIENT',
      }),
      diagnosis:
        `AI Score ${score.aiScore.toFixed(0)} com ${ad.impressions} impressões, ` +
        `abaixo do p${values.impressionsPercentile} ${peerScopeOf(ad).of} (${floor.toFixed(0)}).`,
      // Não é gasto: um item de oportunidade com incorrido diferente de zero
      // entraria em qualquer soma feita por engano como se fosse desperdício.
      incurred: { value: 0, valueBase: 0 },
      avoidableDaily: {
        value: round2(daily.value * headroom),
        valueBase: round2(daily.valueBase * headroom),
      },
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: {
          minAiScore: values.minAiScore,
          minImpressions: floor,
          minPeers: MIN_BENCHMARK_SAMPLE,
        },
        observed: {
          aiScore: score.aiScore,
          impressions: ad.impressions,
          peerMedianImpressions: median,
          headroom,
        },
        scopeLevel: 'AD_SET',
        sampleSize: ctx.adSetPeers.length,
        benchmark: {
          kind: 'AD_SET_PEERS',
          pairs: ctx.adSetPeers.length,
          median,
        },
      }),
      evidenceSufficiency: 'SUFFICIENT',
      scopeLevel: 'AD_SET',
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};
