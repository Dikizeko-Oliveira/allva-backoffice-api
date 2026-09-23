import { Injectable } from '@nestjs/common';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  AdMetricSnapshotRow,
  AdMetricsQuery,
  AdMetricsRepositoryInterface,
} from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type SnapshotRecord = {
  adId: string;
  organizationId: string;
  adAccountId: string;
  campaignId: string;
  adSetId: string | null;
  creativeId: string | null;
  platform: Platform;
  date: Date;
  spend: unknown;
  revenue: unknown;
  spendBase: unknown;
  revenueBase: unknown;
  currency: string;
  baseCurrency: string;
  normalizationPending: boolean;
  impressions: number;
  clicks: number;
  conversions: number;
  reach: number | null;
  frequency: number | null;
  videoViews: number | null;
  engagement: number | null;
  thumbstopRate: number | null;
  holdRate: number | null;
  hides: number | null;
  hideAllFor: number | null;
  reports: number | null;
  unlikes: number | null;
  seriesDiscontinuity: string | null;
  syncedAt: Date;
};

@Injectable()
export class AdMetricsPrismaRepository implements AdMetricsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async query(query: AdMetricsQuery): Promise<AdMetricSnapshotRow[]> {
    const rows = await this.prisma.adMetricSnapshot.findMany({
      where: this.toWhere(query),
      orderBy: { date: 'asc' },
    });

    return rows.map((row) => this.toRow(row as unknown as SnapshotRecord));
  }

  async countActiveAds(query: AdMetricsQuery): Promise<number> {
    const groups = await this.prisma.adMetricSnapshot.groupBy({
      by: ['adId'],
      where: { ...this.toWhere(query), spend: { gt: 0 } },
    });

    return groups.length;
  }

  /**
   * Toda consulta filtra `organizationId` quando há organização no escopo
   * (§16.7). O fallback por `adAccount.accountId` cobre a conta pessoal, que
   * ainda existe enquanto o produto tem os dois modos.
   */
  private toWhere(query: AdMetricsQuery) {
    return {
      date: { gte: query.since, lte: query.until },
      ...(query.organizationId
        ? { organizationId: query.organizationId }
        : query.accountId
          ? { adAccount: { accountId: query.accountId } }
          : {}),
      ...(query.adAccountIds?.length
        ? { adAccountId: { in: query.adAccountIds } }
        : {}),
      ...(query.platforms?.length ? { platform: { in: query.platforms } } : {}),
      ...(query.adIds?.length ? { adId: { in: query.adIds } } : {}),
      ...(query.campaignIds?.length
        ? { campaignId: { in: query.campaignIds } }
        : {}),
    };
  }

  private toRow(record: SnapshotRecord): AdMetricSnapshotRow {
    return {
      adId: record.adId,
      organizationId: record.organizationId,
      adAccountId: record.adAccountId,
      campaignId: record.campaignId,
      adSetId: record.adSetId,
      creativeId: record.creativeId,
      platform: record.platform,
      date: record.date,
      spend: toNumber(record.spend),
      revenue: toNumber(record.revenue),
      currency: record.currency,
      spendBase: toNumber(record.spendBase),
      revenueBase: toNumber(record.revenueBase),
      baseCurrency: record.baseCurrency,
      normalizationPending: record.normalizationPending,
      impressions: record.impressions,
      clicks: record.clicks,
      conversions: record.conversions,
      reach: record.reach,
      frequency: record.frequency,
      videoViews: record.videoViews,
      engagement: record.engagement,
      thumbstopRate: record.thumbstopRate,
      holdRate: record.holdRate,
      hides: record.hides,
      hideAllFor: record.hideAllFor,
      reports: record.reports,
      unlikes: record.unlikes,
      seriesDiscontinuity: record.seriesDiscontinuity,
      syncedAt: record.syncedAt,
    };
  }
}

/**
 * `Decimal` do Prisma chega como objeto com `toString()` próprio; o domínio
 * trabalha com `number`. A checagem explícita do método existe para não cair no
 * `[object Object]` silencioso de um tipo inesperado — um gasto viraria `NaN` e
 * a soma da tela sumiria sem erro.
 */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value == null) return 0;
  if (typeof value === 'string') return Number(value);

  const hasToString =
    typeof value === 'object' &&
    'toString' in value &&
    typeof (value as { toString: unknown }).toString === 'function';

  return hasToString ? Number((value as { toString(): string }).toString()) : 0;
}
