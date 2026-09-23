import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import {
  asDiscontinuityReason,
  type SeriesDiscontinuityReason,
} from 'src/modules/ads/domain/series-discontinuity';

/**
 * **Delta, tendência e alerta não atravessam uma descontinuidade** (§12.5).
 *
 * Este arquivo entra **antes** da coleta dos sinais de feedback negativo, e a
 * ordem é normativa (§15.2). Invertida, o dia do deploy de `hides`/`reports`
 * muda o que `NegativeFeedbackRisk` mede em todo anúncio ativo ao mesmo tempo —
 * e o produto reporta em massa quedas e altas que são artefato de release, não
 * fato sobre a mídia de ninguém.
 *
 * O que se protege aqui não é o score: é a **comparação**. O score de hoje
 * continua sendo calculado e publicado; o que não pode acontecer é compará-lo
 * com o de anteontem como se a régua fosse a mesma.
 */

/** A janela utilizável para comparar, e o que ficou do outro lado do corte. */
export type ComparableWindow<T> = {
  /** Pontos comparáveis entre si — do corte mais recente para cá. */
  points: T[];
  /**
   * O motivo do corte, quando houve. `null` significa série inteira
   * comparável, não "nenhum problema conhecido".
   */
  cutBy: SeriesDiscontinuityReason | null;
  /** Quantos pontos ficaram do outro lado. Vai para `meta.provenance`. */
  droppedBefore: number;
};

type DatedPoint = { date: Date; seriesDiscontinuity: string | null };

/**
 * Corta a série no ponto de descontinuidade **mais recente**, inclusive.
 *
 * O ponto marcado é o primeiro sob a régua nova, então ele **entra** na janela
 * comparável — é o que veio antes dele que se torna incomparável. Excluí-lo
 * jogaria fora o primeiro dia da medição nova sem ganho nenhum.
 *
 * Devolve a série inteira quando não há marca. A ordenação de entrada é
 * respeitada: quem chama já leu ordenado por data, e reordenar aqui esconderia
 * um defeito de consulta em vez de expô-lo.
 */
export function comparableWindow<T extends DatedPoint>(
  series: T[],
): ComparableWindow<T> {
  let cutIndex = -1;
  let cutBy: SeriesDiscontinuityReason | null = null;

  for (let index = series.length - 1; index >= 0; index -= 1) {
    const reason = asDiscontinuityReason(series[index].seriesDiscontinuity);
    if (reason) {
      cutIndex = index;
      cutBy = reason;
      break;
    }
  }

  if (cutIndex <= 0) {
    // Sem marca, ou marca no primeiro ponto: nada a descartar. Um corte no
    // índice 0 não separa nada de nada.
    return {
      points: series,
      cutBy: cutIndex === 0 ? cutBy : null,
      droppedBefore: 0,
    };
  }

  return {
    points: series.slice(cutIndex),
    cutBy,
    droppedBefore: cutIndex,
  };
}

/**
 * `true` quando existe descontinuidade entre dois instantes — logo, quando
 * comparar os dois é comparar réguas diferentes.
 *
 * É o que o cálculo de `scoreDelta7d` e o alerta `AD_SCORE_DROPPED` consultam
 * antes de afirmar que algo caiu.
 */
export function hasDiscontinuityBetween(
  series: DatedPoint[],
  from: Date,
  to: Date,
): boolean {
  const [start, end] = from <= to ? [from, to] : [to, from];

  return series.some((point) => {
    if (!asDiscontinuityReason(point.seriesDiscontinuity)) return false;
    // O ponto marcado é o primeiro sob a régua nova: ele corta a comparação com
    // qualquer coisa **anterior** a ele, e `from` é anterior por construção.
    return point.date > start && point.date <= end;
  });
}

/**
 * Detecta as causas que o próprio sistema é capaz de observar na série.
 *
 * As cinco causas de §12.5 têm origens diferentes, e misturá-las num detector
 * único seria fingir que são o mesmo tipo de fato:
 *
 * | Causa | Quem sabe |
 * |---|---|
 * | `RESUMED_AFTER_PAUSE` | a **série** — é o que esta função vê |
 * | `ATTRIBUTION_WINDOW_CHANGED` | o ingest, ao ler a conta (§8.2) |
 * | `NEW_SIGNAL` | o deploy que passa a coletar um sinal |
 * | `ALGO_VERSION_CHANGED` | a organização, ao trocar a versão ativa |
 * | `CURRENCY_REBASED` | a migração de moeda-base (§4.1) |
 *
 * Só a primeira é derivável do dado. As outras quatro são **eventos**, e quem os
 * conhece marca a linha na hora em que acontecem — inferi-las depois seria
 * adivinhar a partir do sintoma.
 */
export function detectResumedAfterPause(input: {
  series: Array<{ date: Date; impressions: number }>;
  /** Dias sem entrega que quebram a comparabilidade. */
  gapDays?: number;
}): Date[] {
  const gapDays = input.gapDays ?? DEFAULT_PAUSE_GAP_DAYS;
  const delivering = input.series
    .filter((point) => point.impressions > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const marks: Date[] = [];

  for (let index = 1; index < delivering.length; index += 1) {
    const gap =
      (delivering[index].date.getTime() -
        delivering[index - 1].date.getTime()) /
      86_400_000;

    // O ponto marcado é o do **retorno**, não o do último dia antes da pausa:
    // é ele o primeiro sob a régua nova, porque o algoritmo da plataforma
    // reinicia o aprendizado e a série de antes descreve outra entrega.
    if (gap > gapDays) marks.push(delivering[index].date);
  }

  return marks;
}

/**
 * Sete dias sem entrega.
 *
 * Menos que isso é oscilação normal de orçamento e de leilão — marcar aí
 * cortaria a série de anúncios saudáveis toda semana, e uma descontinuidade que
 * acontece o tempo todo não informa nada. Mais que isso, e a retomada de
 * aprendizado da plataforma já aconteceu sem ser registrada.
 */
export const DEFAULT_PAUSE_GAP_DAYS = 7;

/**
 * Aplica as marcas a uma série carregada, sem tocar no banco.
 *
 * Pura de propósito: a decisão de marcar é do domínio, a escrita é de quem tem
 * repositório. A mesma função serve ao cálculo do dia (que precisa saber onde
 * cortar) e ao job que persiste a marca.
 */
export function markResumedAfterPause(
  series: AdMetricSnapshotRow[],
  gapDays: number = DEFAULT_PAUSE_GAP_DAYS,
): AdMetricSnapshotRow[] {
  const marks = new Set(
    detectResumedAfterPause({ series, gapDays }).map((date) => date.getTime()),
  );

  if (marks.size === 0) return series;

  return series.map((row) =>
    marks.has(row.date.getTime()) && !row.seriesDiscontinuity
      ? { ...row, seriesDiscontinuity: 'RESUMED_AFTER_PAUSE' }
      : row,
  );
}
