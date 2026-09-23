import { Injectable } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { AnalyticsQueryDto, periodToDays } from '../dtos/analytics-query.dto';
import { AnalyticsAggregatorService } from '../services/analytics-aggregator.service';

type Health = 'STRONG' | 'OK' | 'WEAK';

@Injectable()
export class GetPlatformHealthUseCase {
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

    const byPlatform = this.aggregator.byPlatform(rows);
    const platforms: Array<{
      platform: Platform;
      health: Health;
      spend: number;
      revenue: number;
      roas: number | null;
      cpa: number | null;
      conversions: number;
      signals: string[];
    }> = [];

    for (const [platform, totals] of Object.entries(byPlatform)) {
      const signals: string[] = [];
      let health: Health = 'OK';
      if (totals.roas !== null) {
        if (totals.roas >= 3) {
          health = 'STRONG';
          signals.push('ROAS >= 3x');
        } else if (totals.roas < 1) {
          health = 'WEAK';
          signals.push('ROAS < 1x');
        }
      }
      if (totals.spend > 0 && totals.conversions === 0) {
        health = 'WEAK';
        signals.push('No conversions on positive spend');
      }
      if (totals.ctr !== null && totals.ctr < 0.5) {
        signals.push('CTR < 0.5%');
        if (health !== 'WEAK') health = 'OK';
      }
      platforms.push({
        platform: platform as Platform,
        health,
        spend: totals.spend,
        revenue: totals.revenue,
        roas: totals.roas,
        cpa: totals.cpa,
        conversions: totals.conversions,
        signals,
      });
    }

    return envelope(
      { period: query.period ?? '30d', platforms },
      { asOf: now.toISOString(), provenance: { windowDays: days } },
    );
  }
}
