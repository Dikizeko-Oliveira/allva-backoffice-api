import { Injectable } from '@nestjs/common';
import { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';

export type AggregatedTotals = {
  spend: number;
  revenue: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  /// Em que moeda os valores acima estão. Agregado sem moeda declarada é número
  /// sem significado quando a organização tem contas em moedas diferentes.
  currency: string | null;
  /// Linhas cuja taxa do dia ainda não existia na ingestão: entraram como zero
  /// na base e o consumidor precisa saber (M1, P7).
  excludedPendingNormalization: number;
};

/**
 * Agregação de série de anúncio.
 *
 * **Soma o normalizado, nunca o original** (M1). Somar `spend` de contas em USD
 * e BRL produz um número que não é dinheiro em moeda nenhuma — era o que a v1
 * fazia, e a soma parecia certa porque ninguém declarava a unidade.
 *
 * `campaignLevelOnly()` **não existe mais** (G10). Ele compensava a dupla
 * contagem de uma tabela que guardava quatro níveis do mesmo gasto; com uma
 * granularidade só, filtrar nível deixou de ser necessário e a função virava
 * convite a reintroduzir o problema.
 */
@Injectable()
export class AnalyticsAggregatorService {
  totals(rows: AdMetricSnapshotRow[]): AggregatedTotals {
    const usable = rows.filter((row) => !row.normalizationPending);
    const t = {
      spend: 0,
      revenue: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    };

    for (const row of usable) {
      t.spend += row.spendBase;
      t.revenue += row.revenueBase;
      t.impressions += row.impressions;
      t.clicks += row.clicks;
      t.conversions += row.conversions;
    }

    return {
      ...t,
      ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
      cpc: t.clicks > 0 ? t.spend / t.clicks : null,
      cpa: t.conversions > 0 ? t.spend / t.conversions : null,
      roas: t.spend > 0 ? t.revenue / t.spend : null,
      currency: usable[0]?.baseCurrency ?? null,
      excludedPendingNormalization: rows.length - usable.length,
    };
  }

  byPlatform(rows: AdMetricSnapshotRow[]): Record<Platform, AggregatedTotals> {
    const groups = new Map<Platform, AdMetricSnapshotRow[]>();
    for (const row of rows) {
      const list = groups.get(row.platform);
      if (list) list.push(row);
      else groups.set(row.platform, [row]);
    }

    const out: Record<string, AggregatedTotals> = {};
    for (const [platform, list] of groups.entries()) {
      out[platform] = this.totals(list);
    }
    return out as Record<Platform, AggregatedTotals>;
  }

  /** Variação percentual contra uma linha de base. `null` se a base for zero. */
  delta(current: number, baseline: number): number | null {
    if (!Number.isFinite(baseline) || baseline === 0) return null;
    return ((current - baseline) / baseline) * 100;
  }
}
