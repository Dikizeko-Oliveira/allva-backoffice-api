/**
 * Shared score primitives. Each calculator returns a `ScoreResult` so callers
 * can compare across scores in a uniform shape.
 *
 * - `value` is normalised to 0-100.
 * - `confidence` ∈ [0,1] reflects how many input signals were actually available
 *   and how much volume backed them (e.g. low impressions → low confidence).
 * - `signals` exposes the intermediate normalised components, useful for
 *   debugging and for future AI enrichment that may reuse the same shape.
 * - `reasons` carries short human-readable contributors used by the optimizer
 *   to build diagnostics.
 */
export type ScoreResult = {
  value: number;
  confidence: number;
  signals: Record<string, number | null>;
  reasons: string[];
};

/**
 * Per-day metric row used by scoring (units matching MetricSnapshotRow):
 * - ctr/cpc/cpa/roas/frequency: same units as in MetricSnapshot
 *   (CTR in % e.g. 1.5; frequency = impressions/reach).
 * - thumbstopRate/holdRate: fractions in [0,1] (Meta convention).
 * - engagement: raw count of engagement actions (e.g. inline_link_clicks).
 */
export type DailyMetric = {
  date: Date;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  frequency: number | null;
  reach: number | null;
  thumbstopRate: number | null;
  holdRate: number | null;
  engagement: number | null;
};

/**
 * Contagens de feedback negativo na janela, somadas — não é média diária
 * porque o sinal é raro e ruidoso: um dia com pico e nove com zero devem
 * pesar pela janela inteira, não pelo dia isolado.
 *
 * `present` é a distinção que `NegativeFeedbackRiskCalculator` precisa antes
 * de qualquer conta: **ausência não é zero** (§12.2, P7). Só a Meta expõe
 * estes quatro campos hoje (`PlatformProfile`); sem `present`, Google e
 * TikTok teriam "zero ocultações" tratado como fato medido, e não como "a
 * plataforma nunca disse".
 */
export type NegativeFeedbackTotals = {
  hides: number;
  hideAllFor: number;
  reports: number;
  unlikes: number;
  present: boolean;
};

export type CreativeAggregate = {
  totals: {
    spend: number;
    revenue: number;
    impressions: number;
    clicks: number;
    conversions: number;
  };
  negativeFeedback: NegativeFeedbackTotals;
  averages: {
    ctr: number | null;
    cpc: number | null;
    cpa: number | null;
    cpm: number | null;
    roas: number | null;
    frequency: number | null;
    thumbstopRate: number | null;
    holdRate: number | null;
    engagementRate: number | null;
    conversionRate: number | null;
  };
  daily: DailyMetric[];
  days: number;
};

export type PortfolioBenchmarks = {
  avgCtr: number | null;
  avgCpa: number | null;
  avgCpm: number | null;
  avgRoas: number | null;
  avgConversionRate: number | null;
};
