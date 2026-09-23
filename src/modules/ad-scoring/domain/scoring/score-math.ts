/**
 * Pure numeric helpers shared by score calculators. No framework deps.
 *
 * Conventions:
 * - "normalize" maps a metric to [0,1] where 1 is the desirable end.
 * - "invertedNormalize" is the same but inverts direction (lower is better).
 * - All helpers gracefully treat null/NaN/Infinity as "missing".
 */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function isPresent(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** Linearly normalises `value` into [0,1] between `low` (0) and `high` (1). */
export function normalize(
  value: number | null | undefined,
  low: number,
  high: number,
): number | null {
  if (!isPresent(value)) return null;
  if (high === low) return null;
  return clamp((value - low) / (high - low), 0, 1);
}

/** Inverse normalisation: lower values map to higher scores. */
export function invertedNormalize(
  value: number | null | undefined,
  low: number,
  high: number,
): number | null {
  const normalised = normalize(value, low, high);
  if (normalised === null) return null;
  return 1 - normalised;
}

/**
 * Weighted average that ignores null components and re-normalises remaining
 * weights so a missing signal does not pull the score toward zero.
 */
export function weightedAverage(
  parts: Array<{ value: number | null; weight: number }>,
): number | null {
  let totalWeight = 0;
  let acc = 0;
  for (const p of parts) {
    if (p.value === null || !Number.isFinite(p.value)) continue;
    if (p.weight <= 0) continue;
    totalWeight += p.weight;
    acc += p.value * p.weight;
  }
  if (totalWeight === 0) return null;
  return acc / totalWeight;
}

/**
 * Confidence based on count of present signals + impressions volume.
 * Returns a value in [0,1].
 *
 * - signal coverage: present / expected
 * - volume factor: impressions saturate at `volumeAt` (full confidence).
 */
export function computeConfidence(args: {
  presentSignals: number;
  expectedSignals: number;
  impressions: number;
  volumeAt: number;
}): number {
  const { presentSignals, expectedSignals, impressions, volumeAt } = args;
  const coverage =
    expectedSignals > 0 ? clamp(presentSignals / expectedSignals, 0, 1) : 0;
  const volumeFactor = clamp(impressions / Math.max(volumeAt, 1), 0, 1);
  // Weighted: signal coverage matters more than raw volume.
  return clamp(coverage * 0.6 + volumeFactor * 0.4, 0, 1);
}

export function mean(values: number[]): number | null {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

export function stdDev(values: number[]): number | null {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (filtered.length < 2) return null;
  const m = mean(filtered);
  if (m === null) return null;
  const variance =
    filtered.reduce((a, b) => a + (b - m) ** 2, 0) / (filtered.length - 1);
  return Math.sqrt(variance);
}

/**
 * Coefficient of variation (std/mean). Returns null when mean ≤ 0 or sample
 * is too small. Used to express relative volatility.
 */
export function coefficientOfVariation(values: number[]): number | null {
  const m = mean(values);
  const s = stdDev(values);
  if (m === null || s === null) return null;
  if (m <= 0) return null;
  return s / m;
}

export function toPct(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 1000) / 10; // one decimal, e.g. 73.4
}
