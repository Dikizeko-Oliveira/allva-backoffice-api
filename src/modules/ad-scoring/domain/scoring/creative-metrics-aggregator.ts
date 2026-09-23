import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { isPresent, mean } from './score-math';
import {
  CreativeAggregate,
  DailyMetric,
  PortfolioBenchmarks,
} from './score-types';

/**
 * Pure aggregator: groups AdMetricSnapshotRow[] into a per-creative aggregate
 * (totals + averages + daily series) that all scoring calculators consume.
 *
 * Stays in the domain layer (no DI) so calculators remain framework-free
 * and trivially unit-testable.
 *
 * A2-S1 trocou a ENTRADA (`MetricSnapshotRow` → `AdMetricSnapshotRow`) porque a
 * tabela de origem deixou de existir; A2-S4 trouxe o ENDEREÇO para cá. **A lógica
 * nunca mudou** (Apêndice C), e é `scoring-calculators.spec.ts` que prova: as
 * mesmas asserções passavam em `creative-lab/domain/scoring/` antes da mudança de
 * pasta e passam aqui depois. Sem essa rede — escrita deliberadamente antes de
 * mover —, "sem mudança de lógica" seria uma afirmação sem verificação.
 */

function toDaily(rows: AdMetricSnapshotRow[]): DailyMetric[] {
  // Multiple rows per day (e.g. several ads under same creative) are merged.
  const byDay = new Map<string, AdMetricSnapshotRow[]>();
  for (const r of rows) {
    const key = new Date(
      Date.UTC(
        r.date.getUTCFullYear(),
        r.date.getUTCMonth(),
        r.date.getUTCDate(),
      ),
    ).toISOString();
    const list = byDay.get(key) ?? [];
    list.push(r);
    byDay.set(key, list);
  }
  const daily: DailyMetric[] = [];
  for (const [iso, list] of byDay.entries()) {
    const totals = list.reduce(
      (acc, r) => ({
        spend: acc.spend + r.spend,
        impressions: acc.impressions + r.impressions,
        clicks: acc.clicks + r.clicks,
        conversions: acc.conversions + r.conversions,
        revenue: acc.revenue + r.revenue,
        frequency: acc.frequency + (r.frequency ?? 0),
        freqCount: acc.freqCount + (r.frequency !== null ? 1 : 0),
        thumbstop: acc.thumbstop + (r.thumbstopRate ?? 0),
        thumbCount: acc.thumbCount + (r.thumbstopRate !== null ? 1 : 0),
        hold: acc.hold + (r.holdRate ?? 0),
        holdCount: acc.holdCount + (r.holdRate !== null ? 1 : 0),
        engagement: acc.engagement + (r.engagement ?? 0),
      }),
      {
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        revenue: 0,
        frequency: 0,
        freqCount: 0,
        thumbstop: 0,
        thumbCount: 0,
        hold: 0,
        holdCount: 0,
        engagement: 0,
      },
    );
    const ctr =
      totals.impressions > 0
        ? (totals.clicks / totals.impressions) * 100
        : null;
    const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
    const cpa =
      totals.conversions > 0 ? totals.spend / totals.conversions : null;
    const roas = totals.spend > 0 ? totals.revenue / totals.spend : null;
    const frequency =
      totals.freqCount > 0 ? totals.frequency / totals.freqCount : null;
    const thumbstopRate =
      totals.thumbCount > 0 ? totals.thumbstop / totals.thumbCount : null;
    const holdRate =
      totals.holdCount > 0 ? totals.hold / totals.holdCount : null;

    daily.push({
      date: new Date(iso),
      spend: totals.spend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      conversions: totals.conversions,
      revenue: totals.revenue,
      ctr,
      cpc,
      cpa,
      roas,
      frequency,
      reach: null,
      thumbstopRate,
      holdRate,
      engagement: totals.engagement > 0 ? totals.engagement : null,
    });
  }
  return daily.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export class CreativeMetricsAggregator {
  static aggregate(rows: AdMetricSnapshotRow[]): CreativeAggregate {
    const daily = toDaily(rows);

    const totals = daily.reduce(
      (acc, d) => ({
        spend: acc.spend + d.spend,
        revenue: acc.revenue + d.revenue,
        impressions: acc.impressions + d.impressions,
        clicks: acc.clicks + d.clicks,
        conversions: acc.conversions + d.conversions,
      }),
      { spend: 0, revenue: 0, impressions: 0, clicks: 0, conversions: 0 },
    );

    // Somado sobre `rows` cru, não sobre `daily`: o dia-agregado não carrega
    // estes quatro campos (não são um sinal de tendência dia a dia, como
    // thumbstop/hold), só a janela inteira importa aqui.
    const negativeFeedback = rows.reduce(
      (acc, r) => ({
        hides: acc.hides + (r.hides ?? 0),
        hideAllFor: acc.hideAllFor + (r.hideAllFor ?? 0),
        reports: acc.reports + (r.reports ?? 0),
        unlikes: acc.unlikes + (r.unlikes ?? 0),
        present:
          acc.present ||
          r.hides !== null ||
          r.hideAllFor !== null ||
          r.reports !== null ||
          r.unlikes !== null,
      }),
      { hides: 0, hideAllFor: 0, reports: 0, unlikes: 0, present: false },
    );

    const ctr =
      totals.impressions > 0
        ? (totals.clicks / totals.impressions) * 100
        : null;
    const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : null;
    const cpa =
      totals.conversions > 0 ? totals.spend / totals.conversions : null;
    const cpm =
      totals.impressions > 0
        ? (totals.spend / totals.impressions) * 1000
        : null;
    const roas = totals.spend > 0 ? totals.revenue / totals.spend : null;
    const conversionRate =
      totals.clicks > 0 ? totals.conversions / totals.clicks : null;
    const engagementRate =
      totals.impressions > 0
        ? daily.reduce((a, d) => a + (d.engagement ?? 0), 0) /
          totals.impressions
        : null;

    const frequency = mean(daily.map((d) => d.frequency).filter(isPresent));
    const thumbstopRate = mean(
      daily.map((d) => d.thumbstopRate).filter(isPresent),
    );
    const holdRate = mean(daily.map((d) => d.holdRate).filter(isPresent));

    return {
      totals,
      negativeFeedback,
      averages: {
        ctr,
        cpc,
        cpa,
        cpm,
        roas,
        frequency,
        thumbstopRate,
        holdRate,
        engagementRate,
        conversionRate,
      },
      daily,
      days: daily.length,
    };
  }

  /**
   * Portfolio benchmarks across an entire owner scope, used by
   * AudienceFit and similar calculators to compare a creative against peers.
   */
  static benchmarks(rows: AdMetricSnapshotRow[]): PortfolioBenchmarks {
    const totals = rows.reduce(
      (acc, r) => ({
        spend: acc.spend + r.spend,
        revenue: acc.revenue + r.revenue,
        impressions: acc.impressions + r.impressions,
        clicks: acc.clicks + r.clicks,
        conversions: acc.conversions + r.conversions,
      }),
      { spend: 0, revenue: 0, impressions: 0, clicks: 0, conversions: 0 },
    );
    return {
      avgCtr:
        totals.impressions > 0
          ? (totals.clicks / totals.impressions) * 100
          : null,
      avgCpa: totals.conversions > 0 ? totals.spend / totals.conversions : null,
      avgCpm:
        totals.impressions > 0
          ? (totals.spend / totals.impressions) * 1000
          : null,
      avgRoas: totals.spend > 0 ? totals.revenue / totals.spend : null,
      avgConversionRate:
        totals.clicks > 0 ? totals.conversions / totals.clicks : null,
    };
  }
}
