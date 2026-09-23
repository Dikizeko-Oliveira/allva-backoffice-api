import { Injectable, Logger } from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { WasteSettingsReader } from 'src/modules/waste/domain/ports/waste-settings.reader';
import { AnalysisScopeRepositoryInterface } from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import { UpgradeSummaryDto } from './dtos/upgrade-summary.dto';

/** A janela declarada quando nem as configurações da organização respondem. */
const FALLBACK_WINDOW_DAYS = 14;

/**
 * O resumo que a tela de contratação mostra quando o teste acaba.
 *
 * ## Por que existe um endpoint só para isto
 *
 * `/waste/summary` e `/recommendations/impact-summary` já sabem tudo o que esta
 * tela precisa — e são rotas de produto, exigindo `ALLOWED`. O
 * `EntitlementGuard` as bloqueia **exatamente** no estado em que a tela roda.
 * O funil terminava num paywall que não conseguia citar um único número do
 * próprio cliente.
 *
 * ## As duas regras que governam o código abaixo
 *
 * **1. Isto nunca lança.** Um paywall que devolve erro é uma venda perdida, e
 * as fontes que ele lê têm três modos de falha perfeitamente normais: conta sem
 * organização, detector desligado por flag (`WASTE_DETECTOR_DISABLED`), motor de
 * recomendação desligado. Nenhum é motivo para negar a tela de pagamento. Cada
 * leitura degrada para `NO_DATA`, e o log fica para quem investiga.
 *
 * **2. Os números vêm dos repositórios de leitura, não de uma consulta nova.**
 * O total de desperdício soma a denormalização de `ads` — o máximo por anúncio.
 * Re-derivá-lo de `waste_items` somaria entre tipos e contaria o mesmo anúncio
 * uma vez por achado: é a dupla contagem que o gate mais importante de A2-S5
 * existe para impedir, e ela reapareceria aqui, na única tela que fala em
 * dinheiro com quem ainda não é cliente.
 *
 * ## O que ele deliberadamente não afirma
 *
 * Não existe campo de "quanto você recuperou". O produto mede pré/pós e rotula
 * `observedDelta`, **jamais** `causedSavings` (P7, D6) — transformar isso numa
 * promessa de economia na tela de vendas seria justamente onde a distinção
 * morreria. O que sai daqui é contagem de vereditos, e o número que vende é
 * `avoidableDaily`: o que continua queimando por dia enquanto ninguém age.
 */
@Injectable()
export class GetUpgradeSummaryUseCase {
  private readonly logger = new Logger(GetUpgradeSummaryUseCase.name);

  constructor(
    private readonly scope: OwnerScopeResolverService,
    private readonly waste: WasteReadRepositoryInterface,
    private readonly wasteSettings: WasteSettingsReader,
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly analysisScope: AnalysisScopeRepositoryInterface,
  ) {}

  async execute(accountId: string): Promise<UpgradeSummaryDto> {
    const owner = await this.softly('scope', () =>
      this.scope.resolveForAccount(accountId),
    );

    const organizationId = owner?.organizationId;
    if (!organizationId) return this.empty();

    const settings = await this.softly('settings', () =>
      this.wasteSettings.forOrganization(organizationId),
    );
    const windowDays = settings?.windowDays ?? FALLBACK_WINDOW_DAYS;

    const [summary, impact, excluded] = await Promise.all([
      this.softly('waste', () =>
        this.waste.summary({ organizationId, windowDays }),
      ),
      this.softly('impact', () =>
        this.recommendations.impactSummary(organizationId),
      ),
      this.softly('analysisScope', () =>
        this.analysisScope.countExcluded(organizationId),
      ),
    ]);

    // Sem nenhuma das duas fontes não há tela a montar. Com uma só, há: um
    // teste que encontrou desperdício e nunca aplicou nada é o caso comum, e é
    // justamente o que mais precisa de paywall.
    if (!summary && !impact) return this.empty(windowDays);

    const applied =
      impact?.byType.reduce((total, row) => total + row.appliedCount, 0) ?? 0;

    const improved =
      impact?.byType.reduce(
        (total, row) => total + (row.byVerdict.IMPROVED ?? 0),
        0,
      ) ?? 0;

    return {
      state: 'READY',
      wasteFound: summary?.incurred
        ? {
            amount: summary.incurred.valueBase,
            currency: summary.incurred.baseCurrency,
          }
        : null,
      avoidableDaily: summary?.avoidableDaily
        ? {
            amount: summary.avoidableDaily.valueBase,
            currency: summary.avoidableDaily.baseCurrency,
          }
        : null,
      affectedAds: summary?.affectedAds ?? 0,
      openFindings: summary?.openCount ?? 0,
      actionsApplied: applied,
      outcomesImproved: improved,
      outcomesMeasured: impact?.measurement.measured ?? 0,
      windowDays,
      /**
       * O número que torna o resto honesto. Sem ele, "R$ 4.812 encontrados"
       * sobre 300 de 5.000 anúncios lê como se fosse o total da organização.
       */
      adsExcludedByPlanLimit: excluded ?? 0,
      asOf: summary?.asOf?.toISOString() ?? null,
    };
  }

  /**
   * Executa uma leitura e engole a falha.
   *
   * O `catch` aqui é a regra 1 acima em código: cada fonte pode faltar sem que
   * a tela de pagamento deixe de abrir. O log em `warn` é o que impede a
   * degradação de virar silêncio — um paywall zerado por bug e um paywall
   * zerado por conta nova são indistinguíveis sem ele.
   */
  private async softly<T>(
    source: string,
    read: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(
        `paywall.source_unavailable fonte=${source} motivo=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private empty(windowDays = FALLBACK_WINDOW_DAYS): UpgradeSummaryDto {
    return {
      state: 'NO_DATA',
      wasteFound: null,
      avoidableDaily: null,
      affectedAds: 0,
      openFindings: 0,
      actionsApplied: 0,
      outcomesImproved: 0,
      outcomesMeasured: 0,
      windowDays,
      adsExcludedByPlanLimit: 0,
      asOf: null,
    };
  }
}
