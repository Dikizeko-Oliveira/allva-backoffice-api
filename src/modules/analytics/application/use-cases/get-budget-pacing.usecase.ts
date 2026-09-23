import { Injectable } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { CurrencyConverterService } from 'src/modules/currency/application/currency-converter.service';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { CampaignBudgetsRepositoryInterface } from 'src/modules/analytics/domain/ports/campaign-budgets.repository';
import {
  computePacing,
  resolveDailyBudget,
  type CampaignBudget,
} from 'src/modules/analytics/domain/budget-pacing';
import { AnalyticsQueryDto, periodToDays } from '../dtos/analytics-query.dto';

/** A versão da régua de ritmo — muda com a fórmula, não com o dado (P7). */
const PACING_VERSION = 'pacing-1.0.0';

/**
 * `GET /analytics/budget-pacing` (N1).
 *
 * Responde *"no ritmo atual, o orçamento acaba antes ou sobra?"* — e responde
 * **sem inventar**: a projeção é extrapolação linear declarada, e tudo que não
 * pôde entrar é contado em vez de silenciosamente ignorado.
 *
 * **Não há campo de insight por IA.** P4 exige que a rota funcione com todos os
 * providers fora, e um texto opcional que some sob falha transforma a mesma tela
 * em duas experiências diferentes sem o usuário saber por quê. O diagnóstico
 * aqui é determinístico inteiro.
 */
@Injectable()
export class GetBudgetPacingUseCase {
  constructor(
    private readonly snapshots: AdMetricsRepositoryInterface,
    private readonly budgets: CampaignBudgetsRepositoryInterface,
    private readonly currency: CurrencyConverterService,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, query: AnalyticsQueryDto) {
    const owner = await this.scope.resolveForAccount(accountId);

    // Sem organização não há anúncio (`ads.organization_id` é NOT NULL), então
    // não há orçamento a acompanhar. Devolver zeros afirmaria "não gasta nada".
    if (!owner.organizationId) {
      return envelope(null, {
        asOf: new Date().toISOString(),
        provenance: { engineVersion: PACING_VERSION },
      });
    }

    const days = periodToDays(query.period);
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

    const [rows, campaigns, organizationBaseCurrency] = await Promise.all([
      this.snapshots.query({
        accountId: owner.accountId,
        organizationId: owner.organizationId,
        platforms: query.platforms as never,
        since,
        until,
      }),
      this.budgets.listActiveWithBudgets({
        organizationId: owner.organizationId,
        platforms: query.platforms as never,
      }),
      this.budgets.organizationBaseCurrency(owner.organizationId),
    ]);

    const spendByCampaign = new Map<string, number>();
    const spendByDate = new Map<string, number>();
    for (const row of rows) {
      spendByCampaign.set(
        row.campaignId,
        (spendByCampaign.get(row.campaignId) ?? 0) + row.spendBase,
      );

      const date = row.date.toISOString().slice(0, 10);
      spendByDate.set(date, (spendByDate.get(date) ?? 0) + row.spendBase);
    }

    const dailySpend = [...spendByDate.entries()]
      .map(([date, spendBase]) => ({ date, spendBase }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // A moeda-base da **organização**, que é a unidade em que `spendBase` já
    // está. Usar `row.currency` aqui pegaria a moeda da conta e compararia
    // orçamento convertido com gasto em outra unidade.
    //
    // Ela sai das linhas, e não da organização, porque durante um recomputo de
    // moeda (§8.7) as duas podem divergir. A organização é só o fallback de
    // janela sem gasto: sem linha nenhuma a moeda caía em `null`, e todo teto
    // era contado como "sem taxa de câmbio" onde não faltava cotação nenhuma.
    const baseCurrency =
      rows.find((row) => row.baseCurrency)?.baseCurrency ??
      organizationBaseCurrency;
    const converted: CampaignBudget[] = [];
    let excludedWithoutRate = 0;

    for (const campaign of campaigns) {
      const dailyBudget = resolveDailyBudget({
        campaignDailyBudget: campaign.dailyBudget,
        adSetDailyBudgets: campaign.adSetDailyBudgets,
      });

      const dailyBudgetBase = await this.toBase(
        dailyBudget,
        campaign.currency,
        baseCurrency,
        until,
      );
      if (dailyBudget !== null && dailyBudgetBase === null) {
        // Sem taxa, o orçamento não é comparável com o gasto normalizado. Entrar
        // com o valor nativo somaria moedas diferentes — o bug que M1 existe
        // para impedir.
        //
        // E a campanha **não segue** para `computePacing`: lá ela chegaria com
        // `dailyBudgetBase: null` e seria contada de novo, como "sem orçamento
        // diário" — a tela afirmava que nenhuma campanha declara teto quando
        // todas declaravam e o que faltava era câmbio.
        excludedWithoutRate += 1;
        continue;
      }

      converted.push({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        platform: campaign.platform,
        dailyBudgetBase,
        spendBase: spendByCampaign.get(campaign.campaignId) ?? 0,
      });
    }

    // Dias decorridos: o período é uma janela para trás terminando hoje, então
    // decorreu inteiro. O campo existe para a fórmula não presumir isso quando
    // a janela virar "mês corrente".
    const elapsedDays = days;

    const pacing = computePacing({
      campaigns: converted,
      elapsedDays,
      periodDays: days,
      dailySpend,
    });

    return envelope(
      {
        period: query.period ?? '30d',
        since: since.toISOString(),
        until: until.toISOString(),
        baseCurrency,
        ...pacing,
        excludedWithoutRate,
      },
      {
        asOf: until.toISOString(),
        provenance: { windowDays: days, engineVersion: PACING_VERSION },
        ...(baseCurrency
          ? {
              organization: {
                baseCurrency,
                recomputingCurrency: false,
              },
            }
          : {}),
      },
    );
  }

  /**
   * `null` quando não há orçamento, quando não se sabe a moeda-base, ou quando
   * não há taxa para a data.
   *
   * O orçamento vem na moeda da **conta** e o gasto já está normalizado: sem a
   * conversão, a comparação somaria unidades diferentes — que é exatamente o que
   * M1 existe para impedir.
   */
  private async toBase(
    amount: number | null,
    fromCurrency: string,
    baseCurrency: string | null,
    date: Date,
  ): Promise<number | null> {
    if (amount === null || baseCurrency === null) return null;
    if (fromCurrency === baseCurrency) return amount;

    const normalized = await this.currency.normalize({
      amount,
      fromCurrency,
      toCurrency: baseCurrency,
      date,
    });

    return normalized.normalizationPending ? null : normalized.valueBase;
  }
}
