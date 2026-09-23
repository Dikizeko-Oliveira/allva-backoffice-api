import { createHash } from 'node:crypto';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';

/**
 * O `inputDigest` de P9 — *"o custo marginal de analisar um anúncio é
 * limitado"*.
 *
 * Sem mudança de digest, o dia seguinte **não recomputa e não chama LLM**. É o
 * mecanismo que impede a janela de re-declaração — que relê os mesmos 14 dias a
 * cada hora — de disparar 14× o custo de scoring e de IA por anúncio por dia.
 *
 * **O que entra no digest é o que muda o score.** Métricas da janela, versão do
 * algoritmo, peso do prior, tamanho da janela e a marca de descontinuidade.
 * `syncedAt` fica **de fora** de propósito: ele muda a cada ingest sem que
 * nenhum número tenha mudado, e incluí-lo faria o digest invalidar sempre —
 * transformando P9 numa cerimônia que não economiza nada.
 */
export function computeInputDigest(input: {
  rows: AdMetricSnapshotRow[];
  algoVersion: string;
  priorWeight: number;
  windowDays: number;
  /**
   * O objetivo entra porque muda o score (`audienceFit` só vale em conversão):
   * um conjunto que troca de "alcance" para "compra" sem nenhuma métrica nova
   * precisa recomputar, e sem isto o digest diria que nada mudou.
   */
  optimizationKey?: string;
}): string {
  const series = [...input.rows]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) =>
      [
        row.date.toISOString().slice(0, 10),
        // Moeda-base, e não a original: é o que a inteligência lê (M1), e um
        // recomputo de câmbio muda o score sem mudar o gasto reportado.
        row.spendBase,
        row.revenueBase,
        row.impressions,
        row.clicks,
        row.conversions,
        row.frequency ?? '',
        row.thumbstopRate ?? '',
        row.holdRate ?? '',
        row.engagement ?? '',
        row.hides ?? '',
        row.hideAllFor ?? '',
        row.reports ?? '',
        row.unlikes ?? '',
        row.seriesDiscontinuity ?? '',
        // Linha sem taxa fica fora das agregações (M1): se ela entra ou sai, o
        // score muda, então o digest tem de enxergar a diferença.
        row.normalizationPending ? 'pending' : '',
      ].join(':'),
    )
    .join('|');

  return createHash('sha256')
    .update(
      `${input.algoVersion}/${input.priorWeight}/${input.windowDays}/${input.optimizationKey ?? ''}#${series}`,
    )
    .digest('hex');
}

/**
 * As linhas que a inteligência pode ler (M1).
 *
 * `normalizationPending` significa que a taxa de câmbio do dia não existia na
 * ingestão: a linha entrou na série — perder o dado seria pior —, mas o valor em
 * moeda-base é zero, e somá-lo faria o gasto do período encolher em silêncio.
 * Ficam de fora do cálculo e a exclusão é **reportada**, nunca escondida.
 */
export function usableForIntelligence(rows: AdMetricSnapshotRow[]): {
  usable: AdMetricSnapshotRow[];
  excludedByNormalization: number;
} {
  const usable = rows.filter((row) => !row.normalizationPending);

  return {
    usable,
    excludedByNormalization: rows.length - usable.length,
  };
}

/** A forma estável do objetivo para o digest: classe, evento e se é contável. */
export function optimizationKeyOf(target: OptimizationTarget): string {
  return [
    target.optimizationClass,
    target.conversionEvent ?? '',
    target.conversionMeasurable ? 'm' : '',
  ].join(':');
}
