import { Injectable } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { WasteSettingsReader } from 'src/modules/waste/domain/ports/waste-settings.reader';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { AnalyticsQueryDto, periodToDays } from '../dtos/analytics-query.dto';
import { AnalyticsAggregatorService } from '../services/analytics-aggregator.service';

/**
 * A visão geral, agora com o desperdício **pela view `open_waste`** (A2-S5,
 * entrega 12).
 *
 * `analytics` não reimplementa a agregação: ela consome o read model de `waste`,
 * que passa obrigatoriamente pela view e pela subconsulta pré-agregada por
 * anúncio. Duplicar a consulta aqui seria recriar, no módulo de rollups, a
 * mesma dupla contagem que §10.8 corrigiu no módulo de detecção — e a segunda
 * cópia divergiria da primeira na primeira calibração.
 */
@Injectable()
export class GetAnalyticsOverviewUseCase {
  constructor(
    private readonly snapshots: AdMetricsRepositoryInterface,
    private readonly aggregator: AnalyticsAggregatorService,
    private readonly scope: OwnerScopeResolverService,
    private readonly waste: WasteReadRepositoryInterface,
    private readonly wasteSettings: WasteSettingsReader,
  ) {}

  async execute(accountId: string, query: AnalyticsQueryDto) {
    const owner = await this.scope.resolveForAccount(accountId);
    const days = periodToDays(query.period);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

    const [current, previous] = await Promise.all([
      this.snapshots.query({
        accountId: owner.accountId,
        organizationId: owner.organizationId,
        platforms: query.platforms as never,
        since,
        until: now,
      }),
      this.snapshots.query({
        accountId: owner.accountId,
        organizationId: owner.organizationId,
        platforms: query.platforms as never,
        since: prevSince,
        until: since,
      }),
    ]);

    const totalsNow = this.aggregator.totals(current);
    const totalsPrev = this.aggregator.totals(previous);

    // Workspace pessoal não tem organização e, por construção, não tem anúncio:
    // `ads.organization_id` é `NOT NULL`. Sem organização não há desperdício a
    // agregar, e devolver zeros aqui afirmaria que não há — que é diferente.
    const waste = owner.organizationId
      ? await this.wasteSummaryFor(owner.organizationId)
      : null;

    return envelope(
      {
        period: query.period ?? '30d',
        since,
        until: now,
        totals: totalsNow,
        /** Par de grandezas de §10.1, via `open_waste`. Nunca somado ao gasto. */
        openWaste: waste,
        deltas: {
          spend: this.aggregator.delta(totalsNow.spend, totalsPrev.spend),
          revenue: this.aggregator.delta(totalsNow.revenue, totalsPrev.revenue),
          conversions: this.aggregator.delta(
            totalsNow.conversions,
            totalsPrev.conversions,
          ),
          roas:
            totalsNow.roas !== null && totalsPrev.roas !== null
              ? this.aggregator.delta(totalsNow.roas, totalsPrev.roas)
              : null,
          cpa:
            totalsNow.cpa !== null && totalsPrev.cpa !== null
              ? this.aggregator.delta(totalsNow.cpa, totalsPrev.cpa)
              : null,
        },
        byPlatform: this.aggregator.byPlatform(current),
      },
      {
        asOf: now.toISOString(),
        provenance: {
          // O período do filtro - a procedência dos **totais**. A janela do
          // desperdício viaja dentro de `openWaste`, que é de quem ela é.
          windowDays: days,
          ...(waste
            ? { excludedByWindowMismatch: waste.excludedByWindowMismatch }
            : {}),
        },
        ...(totalsNow.currency
          ? {
              organization: {
                baseCurrency: totalsNow.currency,
                recomputingCurrency: false,
              },
            }
          : {}),
      },
    );
  }

  /**
   * O bloco de desperdício **carrega a própria janela**.
   *
   * Ele convive na mesma tela com totais lidos no período do filtro, e o card
   * dizia "já gasto na janela" sem nomear qual — sob um filtro escrito "Últimos
   * 30 dias", a leitura natural era que fossem os mesmos 30. São a janela de
   * análise da organização, tipicamente 14. `meta.provenance.windowDays` não
   * servia para desfazer o engano: ali mora o período do filtro, que é a
   * procedência dos *totais*.
   */
  private async wasteSummaryFor(organizationId: string) {
    const config = await this.wasteSettings.forOrganization(organizationId);

    const summary = await this.waste.summary({
      organizationId,
      windowDays: config.windowDays,
    });

    return { ...summary, windowDays: config.windowDays };
  }
}
