import { at, buildEvidence } from '../evidence';
import {
  conservativeThreshold,
  peerScopeOf,
  selectBenchmark,
} from '../benchmark';
import { priorityFor } from '../priority';
import { amountsFrom, clamp01, dailySpendOf } from './amounts';
import type {
  AdScopedDetector,
  DetectionContext,
  Finding,
} from '../detection-context';

/**
 * Os quatro detectores que **não** dependem de conversão.
 *
 * Impressão e clique não são re-declarados pelas plataformas, então `SETTLING`
 * basta (§8.9). Três deles consomem componentes do `AdScore` na **escala
 * nativa** — `fatigue` em 0..1, `negativeFeedbackRisk` e `learningStability` em
 * 0..100 —, e é a nativa de propósito: o valor normalizado existe para o
 * composto, e comparar `fatigueScore ≥ 0,65` contra a escala invertida do
 * composto disparia o detector exatamente quando não deveria.
 */

const DETECTOR_VERSION = 'v2.0.0';

/**
 * `LOW_CTR` — CTR abaixo do p25 dos pares, com volume que sustente a leitura.
 *
 * O incorrido é `spend × (1 − ctr/p50)`: a fração do gasto que não virou clique
 * **em relação ao anúncio mediano do mesmo leilão**. Não é "o gasto todo" porque
 * um CTR ruim ainda entrega alguma coisa; é a diferença para o esperado.
 */
/**
 * `v2.1.0`: a queda para a linha de base da conta compara só anúncios com o
 * mesmo objetivo — o CTR de um anúncio de alcance não é régua para o de venda.
 */
const LOW_CTR_VERSION = 'v2.1.0';

export const lowCtrDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'LOW_CTR',
  version: LOW_CTR_VERSION,
  benchmark: { metric: 'ctr' },

  detect(ctx: DetectionContext): Finding | null {
    const { ad } = ctx;
    if (ad.ctr === null) return null;

    const values = ctx.profile.thresholds.LOW_CTR.values;
    const benchmark = selectBenchmark({
      peers: ctx.adSetPeers,
      accountBaseline: ctx.accountBaseline,
      metric: 'ctr',
      fallbackMultiplier: values.fallbackMultiplier,
    });

    if (!benchmark) return null;

    const floor = at(
      benchmark.percentiles,
      values.floorPercentile as 10 | 25 | 50 | 75,
    );
    const reference = at(
      benchmark.percentiles,
      values.referencePercentile as 10 | 25 | 50 | 75,
    );

    if (floor === null || reference === null || reference <= 0) return null;

    // `BELOW`: o corte **desce** na queda para a conta. Multiplicar aqui deixaria
    // o fallback 50% mais agressivo — o oposto exato do que DEC-3 decidiu.
    const threshold = conservativeThreshold(
      floor,
      'BELOW',
      benchmark.multiplier,
    );

    if (ad.ctr >= threshold) return null;

    const gapRatio = clamp01(1 - ad.ctr / reference);
    const amounts = amountsFrom(ad, gapRatio);

    return {
      adId: ad.adId,
      type: 'LOW_CTR',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: benchmark.sufficiency,
      }),
      diagnosis:
        `CTR ${ad.ctr.toFixed(2)}% contra p${values.floorPercentile} de ` +
        `${threshold.toFixed(2)}% e mediana de ${reference.toFixed(2)}% ` +
        `(${benchmark.kind === 'AD_SET_PEERS' ? `pares ${peerScopeOf(ad).of}` : 'linha de base da conta'}).`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { minCtr: threshold, referenceCtr: reference },
        observed: {
          ctr: ad.ctr,
          impressions: ad.impressions,
          clicks: ad.clicks,
          spendBase: ad.spendBase,
        },
        scopeLevel: benchmark.scopeLevel,
        sampleSize: benchmark.pairs,
        benchmark: {
          kind: benchmark.kind,
          pairs: benchmark.pairs,
          median: reference,
        },
      }),
      evidenceSufficiency: benchmark.sufficiency,
      scopeLevel: benchmark.scopeLevel,
      dataMaturity: ad.dataMaturity,
      detectorVersion: LOW_CTR_VERSION,
    };
  },
};

/**
 * `CREATIVE_FATIGUE` — o criativo cansou o público que ainda alcança.
 *
 * O incorrido é `spend × fatigue × 0,5`: metade do gasto ponderado pela fadiga,
 * porque um criativo fatigado continua entregando — o desperdício é a parte que
 * a repetição deixou de converter, não a verba inteira.
 */
export const creativeFatigueDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'CREATIVE_FATIGUE',
  version: DETECTOR_VERSION,

  detect(ctx: DetectionContext): Finding | null {
    const { ad, score } = ctx;
    const fatigue = score?.components.fatigue?.value;
    if (fatigue === null || fatigue === undefined) return null;

    const values = ctx.profile.thresholds.CREATIVE_FATIGUE.values;
    if (fatigue < values.minFatigueScore) return null;

    const amounts = amountsFrom(ad, fatigue * values.incurredFactor);

    return {
      adId: ad.adId,
      type: 'CREATIVE_FATIGUE',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: 'SUFFICIENT',
      }),
      diagnosis: `Fadiga de criativo em ${fatigue.toFixed(2)} (corte ${values.minFatigueScore}).`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { minFatigueScore: values.minFatigueScore },
        observed: { fatigueScore: fatigue, spendBase: ad.spendBase },
        scopeLevel: 'AD',
        sampleSize: ad.days,
      }),
      evidenceSufficiency: 'SUFFICIENT',
      scopeLevel: 'AD',
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};

/**
 * `NEGATIVE_FEEDBACK` — risco de o público reagir mal ao anúncio.
 *
 * O portão de evidência exige o componente **disponível**, e essa é a linha que
 * importa: enquanto a plataforma não expõe `hides`/`reports`, o componente é
 * `proxyBased` e se declara indisponível (§12.2). Disparar sobre o proxy seria
 * afirmar que o público reagiu mal a partir de um número que mede outra coisa.
 */
export const negativeFeedbackDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'NEGATIVE_FEEDBACK',
  version: DETECTOR_VERSION,

  detect(ctx: DetectionContext): Finding | null {
    const { ad, score } = ctx;
    const risk = score?.components.negativeFeedbackRisk?.value;
    if (risk === null || risk === undefined) return null;

    const values = ctx.profile.thresholds.NEGATIVE_FEEDBACK.values;
    if (risk < values.minRisk) return null;

    const amounts = amountsFrom(ad, values.incurredFactor);

    return {
      adId: ad.adId,
      type: 'NEGATIVE_FEEDBACK',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: 'SUFFICIENT',
      }),
      diagnosis: `Risco de feedback negativo em ${risk.toFixed(0)}/100 (corte ${values.minRisk}).`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { minRisk: values.minRisk },
        observed: { negativeFeedbackRisk: risk, spendBase: ad.spendBase },
        scopeLevel: 'AD',
        sampleSize: ad.days,
      }),
      evidenceSufficiency: 'SUFFICIENT',
      scopeLevel: 'AD',
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};

/**
 * `LEARNING_INSTABILITY` — a entrega não convergiu.
 *
 * `learningStability` é 0..100 com **maior = mais estável**, então o corte é por
 * baixo. Um anúncio instável queima verba enquanto o leilão ainda procura o
 * público, e é por isso que o fator é o menor do catálogo (0,25): parte do gasto
 * de aprendizado é custo legítimo de entrada.
 */
export const learningInstabilityDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'LEARNING_INSTABILITY',
  version: DETECTOR_VERSION,

  detect(ctx: DetectionContext): Finding | null {
    const { ad, score } = ctx;
    const stability = score?.components.learningStability?.value;
    if (stability === null || stability === undefined) return null;

    const values = ctx.profile.thresholds.LEARNING_INSTABILITY.values;
    if (stability >= values.maxStability) return null;
    if (ad.spendBase < values.minSpendBase) return null;

    const amounts = amountsFrom(ad, values.incurredFactor);

    return {
      adId: ad.adId,
      type: 'LEARNING_INSTABILITY',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: 'SUFFICIENT',
      }),
      diagnosis:
        `Estabilidade de aprendizado em ${stability.toFixed(0)}/100 ` +
        `(corte ${values.maxStability}) após ${ad.days} dias.`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: {
          maxStability: values.maxStability,
          minSpendBase: values.minSpendBase,
        },
        observed: {
          learningStability: stability,
          spendBase: ad.spendBase,
          days: ad.days,
        },
        scopeLevel: 'AD',
        sampleSize: ad.days,
      }),
      evidenceSufficiency: 'SUFFICIENT',
      scopeLevel: 'AD',
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};
