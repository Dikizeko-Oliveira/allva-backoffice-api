import { Injectable } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import type { EvidenceSufficiency } from 'src/shared/domain/provenance';
import {
  computeCrossChannelInsight,
  type CrossChannelInsight,
} from 'src/modules/analytics/domain/cross-channel-insight';
import { AnalyticsQueryDto, periodToDays } from '../dtos/analytics-query.dto';
import { AnalyticsAggregatorService } from '../services/analytics-aggregator.service';

/** A versão da régua de realocação — muda com a fórmula, não com o dado (P7). */
const ALLOCATION_VERSION = 'cross-channel-allocation-1.0.0';

/**
 * `GET /analytics/budget-allocation`.
 *
 * Devolve o mix recomendado **e** o insight que o traduz em uma frase com
 * número (§ card "Insight cross-channel"). Os dois moram aqui, e não em
 * `/cross-channel`, por duas razões:
 *
 * 1. É esta a rota da realocação entre canais — o insight é a versão em prosa
 *    da mesma tabela. Calculá-lo na outra rota criaria segunda fonte para o
 *    mesmo número, e as duas divergiriam em silêncio.
 * 2. `/cross-channel` tem seletor de atribuição, e `blended-attribution`
 *    redistribui receita por fatia de gasto. Uma projeção construída sobre isso
 *    mediria a própria redistribuição: o modelo escolhido na tela mudaria a
 *    diferença de ROAS entre os canais sem que nada tivesse mudado na mídia.
 */
@Injectable()
export class GetBudgetAllocationUseCase {
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

    // Efficiency score = ROAS (or 1/CPA fallback). Higher = better.
    const scored = Object.entries(byPlatform).map(([platform, t]) => {
      const efficiency = t.roas ?? (t.cpa && t.cpa > 0 ? 1 / t.cpa : 0);
      return {
        platform: platform as Platform,
        spend: t.spend,
        revenue: t.revenue,
        roas: t.roas,
        cpa: t.cpa,
        efficiency,
        currentShare: totals.spend > 0 ? t.spend / totals.spend : 0,
      };
    });

    const totalEfficiency = scored.reduce(
      (s, x) => s + Math.max(0, x.efficiency),
      0,
    );

    const recommendations = scored.map((x) => {
      const recommendedShare =
        totalEfficiency > 0
          ? Math.max(0, x.efficiency) / totalEfficiency
          : x.currentShare;
      const deltaShare = recommendedShare - x.currentShare;
      const direction =
        Math.abs(deltaShare) < 0.02
          ? 'HOLD'
          : deltaShare > 0
            ? 'INCREASE'
            : 'DECREASE';
      return {
        platform: x.platform,
        currentShare: x.currentShare,
        recommendedShare,
        direction,
        rationale:
          x.roas !== null
            ? `Based on ROAS ${x.roas.toFixed(2)}x over ${days}d`
            : `Based on CPA ${x.cpa?.toFixed(2) ?? 'n/a'}`,
      };
    });

    const insight = computeCrossChannelInsight({
      platforms: Object.entries(byPlatform).map(([platform, t]) => ({
        platform: platform as Platform,
        spendBase: t.spend,
        revenueBase: t.revenue,
        roas: t.roas,
        conversions: t.conversions,
      })),
      totalSpendBase: totals.spend,
      totalRevenueBase: totals.revenue,
      baseCurrency: totals.currency,
      periodDays: days,
      excludedPendingNormalization: totals.excludedPendingNormalization,
    });

    return envelope(
      {
        period: query.period ?? '30d',
        totalSpend: totals.spend,
        totalRevenue: totals.revenue,
        baseCurrency: totals.currency,
        recommendations,
        insight,
      },
      {
        asOf: now.toISOString(),
        evidenceSufficiency: sufficiencyOf(insight),
        provenance: { windowDays: days, engineVersion: ALLOCATION_VERSION },
      },
    );
  }
}

/**
 * `NO_MATERIAL_GAP` é evidência **suficiente** — a resposta apurada é "não vale
 * realocar", que é um veredito, não uma lacuna. Marcá-lo como insuficiente
 * ensinaria a tela a tratar uma conclusão legítima como falha de dado.
 */
function sufficiencyOf(insight: CrossChannelInsight): EvidenceSufficiency {
  if (insight.kind === 'REALLOCATION') return 'SUFFICIENT';
  return insight.reason === 'NO_MATERIAL_GAP' ? 'SUFFICIENT' : 'INSUFFICIENT';
}
