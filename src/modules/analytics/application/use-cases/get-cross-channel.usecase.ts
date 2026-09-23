import { Injectable } from '@nestjs/common';
import {
  AdMetricSnapshotRow,
  AdMetricsRepositoryInterface,
} from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { AnalyticsQueryDto, periodToDays } from '../dtos/analytics-query.dto';
import { AnalyticsAggregatorService } from '../services/analytics-aggregator.service';
import { redistributeRevenue } from '../../domain/revenue-redistribution';

@Injectable()
export class GetCrossChannelUseCase {
  constructor(
    private readonly snapshots: AdMetricsRepositoryInterface,
    private readonly aggregator: AnalyticsAggregatorService,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, query: AnalyticsQueryDto) {
    const owner = await this.scope.resolveForAccount(accountId);
    const days = periodToDays(query.period);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const rows = await this.snapshots.query({
      accountId: owner.accountId,
      organizationId: owner.organizationId,
      platforms: query.platforms as never,
      since,
      until: now,
    });

    const totals = this.aggregator.totals(rows);
    const byPlatform = this.aggregator.byPlatform(rows);
    // Sobre os totais em moeda-base do agregador, e não sobre as linhas cruas:
    // ver `revenue-redistribution.ts` para os dois defeitos que isso corrige.
    const attributedRevenue = redistributeRevenue(
      byPlatform,
      query.attribution ?? 'last-click',
    );

    const timeseries = this.buildTimeseries(rows);

    return envelope(
      {
        period: query.period ?? '30d',
        attribution: query.attribution ?? 'last-click',
        totals,
        byPlatform,
        attributedRevenue,
        timeseries,
      },
      { asOf: now.toISOString(), provenance: { windowDays: days } },
    );
  }

  /**
   * Em moeda-base e sem as linhas de câmbio pendente, como os totais da mesma
   * resposta. Somar `spend`/`revenue` crus misturava moedas de contas
   * diferentes e fazia o gráfico discordar do número ao lado dele.
   */
  private buildTimeseries(rows: AdMetricSnapshotRow[]) {
    const map = new Map<
      string,
      { date: string; spend: number; revenue: number; conversions: number }
    >();
    for (const r of rows) {
      if (r.normalizationPending) continue;
      const key = r.date.toISOString().slice(0, 10);
      const e = map.get(key) ?? {
        date: key,
        spend: 0,
        revenue: 0,
        conversions: 0,
      };
      e.spend += r.spendBase;
      e.revenue += r.revenueBase;
      e.conversions += r.conversions;
      map.set(key, e);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }
}
