import { at, buildEvidence } from '../evidence';
import {
  conservativeThreshold,
  peerScopeOf,
  selectBenchmark,
} from '../benchmark';
import { priorityFor } from '../priority';
import { amountsFrom, clamp01, dailySpendOf, formatBase } from './amounts';
import type {
  AdScopedDetector,
  DetectionContext,
  Finding,
} from '../detection-context';

/**
 * Os três detectores que dependem de **conversão** — e, por isso, os três que só
 * disparam sobre janela `MATURE` (§8.9).
 *
 * A restrição não é conservadorismo: `ZERO_CONVERSIONS` origina
 * `PAUSE_UNDERPERFORMING_AD`, a ação mais destrutiva e mais frequente do
 * catálogo. Disparar sobre dado imaturo é recomendar pausar um anúncio que
 * converteu, e o usuário descobre isso na plataforma, não na Allva.
 */

/**
 * `v2.1.0`: os três só julgam anúncio otimizado para conversão (portão de
 * objetivo em `evidence.ts`), a conversão é o evento da otimização — não mais
 * só compra —, e a linha de base da conta compara quem conta o mesmo evento.
 */
const DETECTOR_VERSION = 'v2.1.0';

/**
 * `ZERO_CONVERSIONS` — gasto sem nenhuma conversão na janela.
 *
 * O corte é `spend ≥ max(p_min, 3 × CPA mediano)`: o piso absoluto impede alarme
 * sobre dez reais, e o múltiplo do CPA mediano é o que torna o achado
 * significativo em vez de literal — gastar o equivalente a três conversões
 * típicas sem nenhuma é evidência; gastar o de um terço não é.
 */
export const zeroConversionsDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'ZERO_CONVERSIONS',
  version: DETECTOR_VERSION,

  detect(ctx: DetectionContext): Finding | null {
    const { ad } = ctx;
    if (ad.conversions > 0) return null;

    const values = ctx.profile.thresholds.ZERO_CONVERSIONS.values;
    const benchmark = selectBenchmark({
      peers: ctx.adSetPeers,
      accountBaseline: ctx.accountBaseline,
      metric: 'cpa',
      fallbackMultiplier: values.fallbackMultiplier,
    });

    const medianCpa = benchmark ? at(benchmark.percentiles, 50) : null;
    const cpaFloor =
      medianCpa !== null && benchmark
        ? conservativeThreshold(
            medianCpa * values.medianCpaMultiple,
            'ABOVE',
            benchmark.multiplier,
          )
        : 0;

    const threshold = Math.max(values.minSpendBase, cpaFloor);
    if (ad.spendBase < threshold) return null;

    // Nenhuma conversão: o gasto inteiro da janela é o desperdício incorrido, e
    // o gasto diário inteiro é o que pausar interrompe. Fator 1.
    const amounts = amountsFrom(ad, 1);

    // Sem benchmark nenhum o achado se apoia só no piso absoluto — evidência
    // real, mas sem termo de comparação. `PARTIAL` é exatamente esse caso, e é
    // por ele que §7.0.1 tem quatro valores e não três.
    const sufficiency = benchmark ? benchmark.sufficiency : 'PARTIAL';

    return {
      adId: ad.adId,
      type: 'ZERO_CONVERSIONS',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency,
      }),
      diagnosis:
        `${ad.days} dias, ${formatBase(ad.spendBase, ad.baseCurrency)} gastos, ` +
        `nenhuma conversão.`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { minSpendBase: threshold, maxConversions: 0 },
        observed: {
          spendBase: ad.spendBase,
          conversions: ad.conversions,
          revenueBase: ad.revenueBase,
          days: ad.days,
        },
        scopeLevel: benchmark?.scopeLevel ?? 'AD',
        sampleSize: ad.days,
        ...(benchmark
          ? {
              benchmark: {
                kind: benchmark.kind,
                pairs: benchmark.pairs,
                median: medianCpa,
              },
            }
          : {}),
      }),
      evidenceSufficiency: sufficiency,
      scopeLevel: benchmark?.scopeLevel ?? 'AD',
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};

/**
 * `LOW_ROAS` — receita abaixo do gasto, com conversão suficiente para saber.
 *
 * Não usa benchmark: ROAS < 1 é um fato aritmético sobre o próprio anúncio, não
 * uma comparação. Um ad set inteiro com ROAS 0,8 continua sendo prejuízo, e
 * comparar contra a mediana dos pares faria o pior conjunto da conta parecer
 * saudável por unanimidade.
 */
export const lowRoasDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'LOW_ROAS',
  version: DETECTOR_VERSION,

  detect(ctx: DetectionContext): Finding | null {
    const { ad } = ctx;
    const values = ctx.profile.thresholds.LOW_ROAS.values;

    if (ad.roas === null || ad.roas >= values.maxRoas) return null;
    if (ad.spendBase <= 0) return null;

    // O déficit como fração do gasto: é o que sobra depois de a receita cobrir a
    // parte que cobriu. Aplicado às duas moedas, mantém a dupla persistência
    // coerente sem tocar em câmbio.
    const deficitRatio = clamp01(
      (ad.spendBase - ad.revenueBase) / ad.spendBase,
    );
    const amounts = amountsFrom(ad, deficitRatio);

    return {
      adId: ad.adId,
      type: 'LOW_ROAS',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: 'SUFFICIENT',
      }),
      diagnosis:
        `ROAS ${ad.roas.toFixed(2)} em ${ad.days} dias: ` +
        `${formatBase(ad.spendBase, ad.baseCurrency)} gastos para ` +
        `${formatBase(ad.revenueBase, ad.baseCurrency)} de receita.`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { maxRoas: values.maxRoas },
        observed: {
          roas: ad.roas,
          spendBase: ad.spendBase,
          revenueBase: ad.revenueBase,
          conversions: ad.conversions,
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

/**
 * `HIGH_CPA` — custo por aquisição acima do múltiplo da mediana (DEC-3).
 *
 * O corte nominal é 2× a mediana do ad set; com menos de 3 pares, a queda
 * declarada leva a 2 × 1,5 = **3× a mediana da conta**, que é exatamente o que
 * §10.5 escreve como regra separada. Uma regra só, com o fallback explícito,
 * evita que as duas divirjam na próxima calibração.
 */
export const highCpaDetector: AdScopedDetector = {
  scope: 'AD',
  type: 'HIGH_CPA',
  version: DETECTOR_VERSION,
  benchmark: { metric: 'cpa' },

  detect(ctx: DetectionContext): Finding | null {
    const { ad } = ctx;
    if (ad.cpa === null || ad.spendBase <= 0) return null;

    const values = ctx.profile.thresholds.HIGH_CPA.values;
    const benchmark = selectBenchmark({
      peers: ctx.adSetPeers,
      accountBaseline: ctx.accountBaseline,
      metric: 'cpa',
      fallbackMultiplier: values.fallbackMultiplier,
    });

    // Conta com menos de 3 anúncios não tem linha de base: inventar uma a partir
    // de dois anúncios produz um limiar que é só o outro anúncio com outro nome.
    if (!benchmark) return null;

    const medianCpa = at(benchmark.percentiles, 50);
    if (medianCpa === null || medianCpa <= 0) return null;

    const threshold = conservativeThreshold(
      medianCpa * values.cpaMultiple,
      'ABOVE',
      benchmark.multiplier,
    );

    if (ad.cpa <= threshold) return null;

    // O excedente sobre o que as mesmas conversões custariam ao CPA mediano.
    const expectedSpendBase = ad.conversions * medianCpa;
    const excessRatio = clamp01(
      (ad.spendBase - expectedSpendBase) / ad.spendBase,
    );
    const amounts = amountsFrom(ad, excessRatio);

    return {
      adId: ad.adId,
      type: 'HIGH_CPA',
      kind: 'WASTE',
      priority: priorityFor({
        avoidableDailyBase: amounts.avoidableDaily.valueBase,
        dailySpendBase: dailySpendOf(ad).valueBase,
        sufficiency: benchmark.sufficiency,
      }),
      diagnosis:
        `CPA ${formatBase(ad.cpa, ad.baseCurrency)} contra mediana de ` +
        `${formatBase(medianCpa, ad.baseCurrency)} ${
          benchmark.kind === 'AD_SET_PEERS'
            ? `em ${benchmark.pairs} pares ${peerScopeOf(ad).of}`
            : `da conta (${benchmark.pairs} anúncios) — sem pares suficientes ${peerScopeOf(ad).in}`
        }.`,
      incurred: amounts.incurred,
      avoidableDaily: amounts.avoidableDaily,
      currency: ad.currency,
      baseCurrency: ad.baseCurrency,
      evidence: buildEvidence({
        thresholds: { maxCpa: threshold, cpaMultiple: values.cpaMultiple },
        observed: {
          cpa: ad.cpa,
          conversions: ad.conversions,
          spendBase: ad.spendBase,
        },
        scopeLevel: benchmark.scopeLevel,
        sampleSize: benchmark.pairs,
        benchmark: {
          kind: benchmark.kind,
          pairs: benchmark.pairs,
          median: medianCpa,
        },
      }),
      evidenceSufficiency: benchmark.sufficiency,
      scopeLevel: benchmark.scopeLevel,
      dataMaturity: ad.dataMaturity,
      detectorVersion: DETECTOR_VERSION,
    };
  },
};
