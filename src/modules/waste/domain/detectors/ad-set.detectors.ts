import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import { slope } from '../baseline';
import { attribute } from '../attribution';
import { buildEvidence } from '../evidence';
import { priorityFor } from '../priority';
import { AVOIDABLE_WINDOW_DAYS, amountsFrom, dailySpendOf } from './amounts';
import type {
  AdSetDetectionContext,
  AdSetScopedDetector,
  AdWindowAggregate,
  Finding,
} from '../detection-context';

/**
 * A família `AD_SET` (§10.3) — avalia o **conjunto** e devolve achados **já
 * atribuídos** a anúncios específicos.
 *
 * Os dois casos em que o fenômeno não é do anúncio isolado: o público satura
 * para o conjunto inteiro, e dois anúncios só competem entre si porque estão no
 * mesmo leilão. Atribuir ao anúncio de menor `aiScore` (empate por menor `id`)
 * não é arbitrariedade disfarçada — é o que mantém o fingerprint estável entre
 * execuções, sem o quê a deduplicação quebra e o mesmo problema reaparece como
 * item novo a cada ciclo.
 *
 * **O valor monetário continua sendo do anúncio** (P2). Um achado de escopo
 * `AD_SET` que carregasse o gasto do conjunto poria dinheiro acima do anúncio, e
 * a soma entre achados voltaria a contar o mesmo gasto duas vezes.
 */

const DETECTOR_VERSION = 'v2.0.0';

/**
 * `AUDIENCE_SATURATION` (DEC-4) — **frequência subindo**, não alcance parado.
 *
 * A primeira redação exigia "alcance estagnado em 7 dias", e isso não é
 * computável: reach é contagem de pessoas distintas e **não soma** entre dias —
 * somar sete dias conta a mesma pessoa sete vezes. Reach deduplicado de 7 dias
 * exige uma chamada de insights adicional por conjunto, que muda o orçamento de
 * R4 e entra em A2-S8 se couber.
 *
 * O proxy da v2.0 é a combinação de três coisas, e é a combinação que importa:
 * frequência média alta sozinha não é saturação (um público pequeno sempre teve
 * frequência alta); frequência **subindo** com impressões estáveis ou em queda é
 * o mesmo público sendo reimpactado.
 *
 * Onde `PlatformProfile.metrics.unavailable.frequency` está declarado — Search
 * no Google —, o detector **não roda**. Rodar sobre frequência ausente reportaria
 * saturação a partir de um `null`.
 */
export const audienceSaturationDetector: AdSetScopedDetector = {
  scope: 'AD_SET',
  type: 'AUDIENCE_SATURATION',
  version: DETECTOR_VERSION,

  detect(ctx: AdSetDetectionContext): Finding[] {
    const delivering = ctx.ads.filter((ad) => ad.isDelivering);
    if (delivering.length === 0) return [];

    const profile = platformProfile(delivering[0].platform);
    if (profile.metrics.unavailable.frequency) return [];

    const values = ctx.profile.thresholds.AUDIENCE_SATURATION.values;
    const series = adSetFrequencySeries(delivering);
    const window = series.slice(-AVOIDABLE_WINDOW_DAYS);
    if (window.length < 2) return [];

    const frequencies = window.map((point) => point.frequency);
    const measured = frequencies.filter(
      (value): value is number => value !== null,
    );
    if (measured.length === 0) return [];

    const meanFrequency =
      measured.reduce((sum, value) => sum + value, 0) / measured.length;
    if (meanFrequency <= values.minFrequency) return [];

    const frequencySlope = slope(frequencies);
    if (frequencySlope === null || frequencySlope <= values.minSlope) return [];

    const growth = impressionGrowth(window.map((point) => point.impressions));
    if (growth === null || growth > values.maxImpressionGrowth) return [];

    const attribution = attribute(delivering, ctx.scores);
    if (!attribution) return [];

    const target = delivering.find((ad) => ad.adId === attribution.adId);
    if (!target) return [];

    const amounts = amountsFrom(target, values.incurredFactor);

    return [
      {
        adId: target.adId,
        type: 'AUDIENCE_SATURATION',
        kind: 'WASTE',
        priority: priorityFor({
          avoidableDailyBase: amounts.avoidableDaily.valueBase,
          dailySpendBase: dailySpendOf(target).valueBase,
          sufficiency: 'SUFFICIENT',
        }),
        diagnosis:
          `O conjunto está com frequência média ${meanFrequency.toFixed(2)} em ` +
          `${window.length} dias, subindo, e as impressões não crescem — o mesmo ` +
          `público está sendo reimpactado.`,
        incurred: amounts.incurred,
        avoidableDaily: amounts.avoidableDaily,
        currency: target.currency,
        baseCurrency: target.baseCurrency,
        evidence: buildEvidence({
          thresholds: {
            minFrequency: values.minFrequency,
            minSlope: values.minSlope,
            maxImpressionGrowth: values.maxImpressionGrowth,
          },
          observed: {
            meanFrequency,
            frequencySlope,
            impressionGrowth: growth,
            adsInSet: delivering.length,
          },
          scopeLevel: 'AD_SET',
          relatedAdIds: attribution.relatedAdIds,
          attributionRule: attribution.rule,
          sampleSize: window.length,
        }),
        evidenceSufficiency: 'SUFFICIENT',
        scopeLevel: 'AD_SET',
        dataMaturity: target.dataMaturity,
        detectorVersion: DETECTOR_VERSION,
      },
    ];
  },
};

/**
 * `OVERLAPPING_DELIVERY` (DEC-5) — o **mesmo conteúdo** competindo no mesmo
 * leilão.
 *
 * A primeira redação exigia "público sobreposto", que é tautológico dentro do
 * mesmo ad set — o público é o mesmo por definição — e incomputável entre
 * conjuntos com o que o sync coleta. O que é observável e acionável é conteúdo
 * idêntico disputando o mesmo leilão, que é a causa concreta do desperdício.
 * Sobreposição real entre conjuntos e canibalização estão no Horizonte 2.
 *
 * O nome do enum é preservado de propósito: a família se expande, não se
 * substitui, e trocar o nome faria os achados antigos deixarem de casar com os
 * novos por fingerprint.
 */
export const overlappingDeliveryDetector: AdSetScopedDetector = {
  scope: 'AD_SET',
  type: 'OVERLAPPING_DELIVERY',
  version: DETECTOR_VERSION,

  detect(ctx: AdSetDetectionContext): Finding[] {
    const values = ctx.profile.thresholds.OVERLAPPING_DELIVERY.values;

    const eligible = ctx.ads.filter(
      (ad) =>
        ad.isDelivering &&
        ad.contentHash !== null &&
        ad.spendBase >= values.minSpendBase,
    );

    const byContent = new Map<string, AdWindowAggregate[]>();
    for (const ad of eligible) {
      const bucket = byContent.get(ad.contentHash as string) ?? [];
      bucket.push(ad);
      byContent.set(ad.contentHash as string, bucket);
    }

    const findings: Finding[] = [];

    for (const [contentHash, group] of byContent) {
      if (group.length < 2) continue;

      const attribution = attribute(group, ctx.scores);
      if (!attribution) continue;

      const worst = group.find((ad) => ad.adId === attribution.adId);
      if (!worst) continue;

      // "`spend` do pior" (§10.5): o gasto duplicado é o do anúncio que perde a
      // comparação, porque consolidar significa manter o outro. Somar os dois
      // contaria o gasto que continua fazendo sentido.
      const amounts = amountsFrom(worst, 1);

      findings.push({
        adId: worst.adId,
        type: 'OVERLAPPING_DELIVERY',
        kind: 'WASTE',
        priority: priorityFor({
          avoidableDailyBase: amounts.avoidableDaily.valueBase,
          dailySpendBase: dailySpendOf(worst).valueBase,
          sufficiency: 'SUFFICIENT',
        }),
        diagnosis:
          `${group.length} anúncios do mesmo conjunto veiculam conteúdo idêntico ` +
          `e disputam o mesmo leilão.`,
        incurred: amounts.incurred,
        avoidableDaily: amounts.avoidableDaily,
        currency: worst.currency,
        baseCurrency: worst.baseCurrency,
        evidence: buildEvidence({
          thresholds: { minSpendBase: values.minSpendBase, minAds: 2 },
          observed: {
            adsWithSameContent: group.length,
            spendBase: worst.spendBase,
          },
          scopeLevel: 'AD_SET',
          relatedAdIds: attribution.relatedAdIds,
          attributionRule: `${attribution.rule}:contentHash=${contentHash.slice(0, 12)}`,
          sampleSize: group.length,
        }),
        evidenceSufficiency: 'SUFFICIENT',
        scopeLevel: 'AD_SET',
        dataMaturity: worst.dataMaturity,
        detectorVersion: DETECTOR_VERSION,
      });
    }

    return findings;
  },
};

/**
 * Frequência do conjunto por dia, **ponderada por impressão**.
 *
 * A média simples entre anúncios trataria um anúncio com dez impressões e outro
 * com cem mil como iguais, e a frequência do conjunto passaria a ser dominada
 * pelo anúncio que quase não entregou.
 */
function adSetFrequencySeries(
  ads: AdWindowAggregate[],
): Array<{ date: Date; frequency: number | null; impressions: number }> {
  const byDay = new Map<
    number,
    { impressions: number; weighted: number; measured: number }
  >();

  for (const ad of ads) {
    for (const point of ad.daily) {
      const key = point.date.getTime();
      const bucket = byDay.get(key) ?? {
        impressions: 0,
        weighted: 0,
        measured: 0,
      };
      bucket.impressions += point.impressions;
      if (point.frequency !== null) {
        bucket.weighted += point.frequency * point.impressions;
        bucket.measured += point.impressions;
      }
      byDay.set(key, bucket);
    }
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, bucket]) => ({
      date: new Date(time),
      frequency: bucket.measured > 0 ? bucket.weighted / bucket.measured : null,
      impressions: bucket.impressions,
    }));
}

/**
 * Crescimento das impressões: metade recente contra metade anterior.
 *
 * Comparar médias de duas metades, e não a inclinação, é o que responde à
 * pergunta certa — "as impressões pararam de crescer?" — sem que um único dia
 * atípico no meio da janela decida o veredito.
 */
function impressionGrowth(impressions: number[]): number | null {
  if (impressions.length < 2) return null;

  const middle = Math.floor(impressions.length / 2);
  const older = impressions.slice(0, middle);
  const newer = impressions.slice(middle);

  const olderMean =
    older.reduce((sum, value) => sum + value, 0) / Math.max(1, older.length);
  const newerMean =
    newer.reduce((sum, value) => sum + value, 0) / Math.max(1, newer.length);

  if (olderMean <= 0) return null;
  return newerMean / olderMean - 1;
}

/** Exposto para o teste da janela diária do conjunto. */
export const adSetInternals = { adSetFrequencySeries, impressionGrowth };
