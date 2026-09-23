import type {
  AdWindowAggregate,
  Baseline,
  Percentiles,
} from './detection-context';

/**
 * Linha de base por **mediana e percentis, nunca média** (§10.3).
 *
 * Corrige o Apêndice A nº 7. A média é o benchmark errado por uma razão
 * mecânica, não estética: um único anúncio com CPA de R$ 900 numa conta cujo CPA
 * típico é R$ 30 puxa a média para cima o bastante para o próprio anúncio deixar
 * de ser detectável — o outlier eleva o limiar que deveria pegá-lo. A mediana
 * não se move.
 */

/**
 * Percentil por interpolação linear sobre a amostra ordenada.
 *
 * Amostra vazia devolve `null`, e `null` **não** vira zero em lugar nenhum: um
 * benchmark ausente é ausência de comparação, e comparar contra zero faria todo
 * anúncio parecer infinitamente pior que a conta.
 */
export function percentile(values: number[], p: number): number | null {
  const usable = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  // O épsilon evita que a divisão flutuante caia um passo abaixo do índice
  // exato: sem ele, `percentile([10,20,30,40,50], 50)` pode devolver 29,999…
  const rank = (p / 100) * (usable.length - 1) + Number.EPSILON;
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, usable.length - 1);
  const weight = rank - lower;

  return usable[lower] + (usable[upper] - usable[lower]) * weight;
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

function percentilesOf(values: number[]): Percentiles {
  return {
    p10: percentile(values, 10),
    p25: percentile(values, 25),
    p50: percentile(values, 50),
    p75: percentile(values, 75),
  };
}

/**
 * A linha de base de um conjunto de anúncios.
 *
 * Cada grandeza é calculada sobre os anúncios em que ela **existe**: um anúncio
 * sem conversão não tem CPA, e incluí-lo como zero faria a mediana de CPA
 * despencar até nenhum anúncio caro ser caro. A amostra por grandeza é diferente
 * de propósito, e `sampleSize` reporta a do conjunto para que a evidência
 * declare sobre quantos pares o achado se apoia.
 */
export function buildBaseline(ads: AdWindowAggregate[]): Baseline {
  return {
    sampleSize: ads.length,
    cpa: percentilesOf(
      ads
        .map((ad) => ad.cpa)
        .filter((value): value is number => value !== null),
    ),
    ctr: percentilesOf(
      ads
        .map((ad) => ad.ctr)
        .filter((value): value is number => value !== null),
    ),
    roas: percentilesOf(
      ads
        .map((ad) => ad.roas)
        .filter((value): value is number => value !== null),
    ),
    impressions: percentilesOf(ads.map((ad) => ad.impressions)),
  };
}

/** Média diária da grandeza sobre os **últimos** `days` dias observados. */
export function dailyAverageOverLastDays(
  points: Array<{ date: Date; value: number }>,
  days: number,
): number {
  if (points.length === 0) return 0;

  const ordered = [...points].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const window = ordered.slice(-Math.max(1, days));
  const total = window.reduce((sum, point) => sum + point.value, 0);

  // Divide pelos dias da janela pedida, não pelos dias observados: um anúncio
  // que gastou R$ 700 em um único dia dos últimos sete gasta R$ 100/dia, não
  // R$ 700/dia — e é a primeira leitura que estima o que se interrompe amanhã.
  return total / Math.max(1, Math.min(days, ordered.length));
}

/**
 * Inclinação da reta por mínimos quadrados sobre a série.
 *
 * Usada por `AUDIENCE_SATURATION` (DEC-4): frequência **média alta** não é
 * saturação — um público pequeno sempre teve frequência alta. Saturação é
 * frequência **subindo** com impressões estáveis ou em queda, e é a inclinação
 * que distingue as duas.
 */
export function slope(values: Array<number | null>): number | null {
  const points = values
    .map((value, index) => ({ x: index, y: value }))
    .filter((point): point is { x: number; y: number } => point.y !== null);

  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  return (n * sumXY - sumX * sumY) / denominator;
}
