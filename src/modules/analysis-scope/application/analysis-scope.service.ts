import { Injectable, Logger } from '@nestjs/common';
import {
  OrganizationPlanPortInterface,
  OrganizationQuotaPortInterface,
} from 'src/modules/organizations/domain/ports';
import { AnalysisScopeRepositoryInterface } from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import {
  rankingWindow,
  rotationCycleNights,
  splitScope,
} from 'src/modules/analysis-scope/domain/scope-split';
import { planLimitOrUnlimited } from 'src/modules/plans/domain/plan-entitlements';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';

/** A janela sobre a qual o gasto é somado para ordenar. */

export type AnalysisScopeRun = {
  organizations: number;
  eligible: number;
  excludedByPlanLimit: number;
};

/**
 * Decide, uma vez por noite, **quais anúncios a Allva analisa**.
 *
 * ## Por que o teto não é uma parede
 *
 * O plano do Individual diz 300 anúncios. Um cliente conecta uma conta com
 * 5.000. Recusar o ingest acima de 300 perderia dado e faria o total de
 * desperdício da organização ser somado sobre uma leitura incompleta — um número
 * **errado**, que é pior que um número declaradamente parcial. Recusar a conexão
 * é pior ainda: a contagem só se conhece depois de conectar.
 *
 * Então ingere-se tudo, e o teto governa a análise. Ingest é linha em tabela e é
 * barato; o custo real é scoring, detectores e LLM — e é exatamente esse que o
 * teto passa a limitar. O anúncio fora do conjunto continua sincronizado,
 * visível e com métricas; só não é analisado naquela noite.
 *
 * ## Por que roda antes de todo mundo
 *
 * `ad-scoring` roda às 05:30 e `waste` às 06:00, e entre as duas o ingest de
 * hora em hora reescreve o gasto do dia. Se cada motor ordenasse por conta
 * própria, o score analisaria um conjunto e o detector outro — sobre a mesma
 * organização, na mesma noite. Esta corrida decide uma vez, às 05:00, e os dois
 * leem o carimbo.
 */
@Injectable()
export class AnalysisScopeService {
  private readonly logger = new Logger(AnalysisScopeService.name);

  constructor(
    private readonly scope: AnalysisScopeRepositoryInterface,
    private readonly plans: OrganizationPlanPortInterface,
    private readonly quotas: OrganizationQuotaPortInterface,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  async execute(now: Date = new Date()): Promise<AnalysisScopeRun> {
    /**
     * Só organização com acesso aberto. A régua existe para o scoring e a
     * detecção, e nenhum dos dois roda para quem perdeu acesso — carimbar os
     * anúncios dela seria escrita em massa toda madrugada para ninguém ler.
     */
    const { kept: organizations, skipped } = await this.sweep.keepByMode(
      await this.scope.listOrganizationsWithAds(),
      (organizationId) => organizationId,
      ['FULL'],
      now,
    );

    const { since, until } = rankingWindow(now);

    const run: AnalysisScopeRun = {
      organizations: organizations.length,
      eligible: 0,
      excludedByPlanLimit: 0,
    };

    for (const organizationId of organizations) {
      await this.markOrganization(organizationId, since, until, now, run);
    }

    this.logger.log(
      `analysis_scope.done organizacoes=${run.organizations} ` +
        `analisados=${run.eligible} fora=${run.excludedByPlanLimit} ` +
        `fora_por_acesso=${skipped}`,
    );

    return run;
  }

  /**
   * A régua para **uma** organização, fora do ciclo noturno.
   *
   * Existe para a conta recém-conectada: sem o carimbo desta corrida,
   * `listScorable` volta vazio e o scoring retorna sem escrever nem logar — o
   * que é indistinguível de "o job não rodou". Esperar as 05:00 do dia seguinte
   * para o primeiro score é justamente a espera que a conexão deveria eliminar.
   */
  async executeForOrganization(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<AnalysisScopeRun> {
    const { since, until } = rankingWindow(now);

    const run: AnalysisScopeRun = {
      organizations: 1,
      eligible: 0,
      excludedByPlanLimit: 0,
    };

    await this.markOrganization(organizationId, since, until, now, run);
    return run;
  }

  private async markOrganization(
    organizationId: string,
    since: Date,
    until: Date,
    now: Date,
    run: AnalysisScopeRun,
  ): Promise<void> {
    try {
      const planType =
        await this.plans.findPlanTypeByOrganizationId(organizationId);

      /**
       * **Plano irresolúvel não corta ninguém.** É a assimetria oposta à de
       * `planAllows`, e de propósito: lá, fechar na dúvida evita uma escrita
       * em mídia paga que ninguém pediu; aqui, fechar na dúvida faria a
       * organização inteira sumir da análise numa madrugada, e o produto
       * reportaria zero desperdício como se fosse um fato sobre a mídia.
       */
      /**
       * O teto negociado vence o do plano.
       *
       * Sem isto, o contrato do cliente Enterprise valeria ao vincular conta e
       * não valeria aqui — e a divergência apareceria só como "sumiram
       * anúncios da análise", numa madrugada, sem ninguém relacionar as duas
       * coisas.
       */
      const negotiated = (await this.quotas.findOverrides(organizationId))
        .monitoredAds;

      const limit =
        negotiated ?? planLimitOrUnlimited(planType, 'monitored-ads');

      const outcome = await this.scope.markEligible({
        organizationId,
        limit,
        since,
        until,
        now,
      });

      run.eligible += outcome.eligible;
      run.excludedByPlanLimit += outcome.excludedByPlanLimit;

      if (outcome.excludedByPlanLimit > 0) {
        /**
         * O ciclo do rodízio no log, e é a resposta que o suporte precisa.
         *
         * "Por que este anúncio ainda não foi analisado?" tinha resposta
         * definitiva antes — ele estava fora do teto, e ficaria para sempre.
         * Agora a resposta é "está na fila", e sem o número a frase não vale
         * nada. É uma estimativa por cima: o rodízio só considera anúncio com
         * entrega na janela, então o ciclo real costuma ser bem menor que este.
         */
        const cycle = rotationCycleNights(
          splitScope(limit),
          outcome.excludedByPlanLimit,
        );

        this.logger.log(
          `analysis_scope.capped organizacao=${organizationId} ` +
            `analisados=${outcome.eligible} fora=${outcome.excludedByPlanLimit} teto=${limit}` +
            (cycle === null ? '' : ` ciclo<=${cycle}noites`),
        );
      }
    } catch (error) {
      // Uma organização que falha não pode derrubar a régua das outras: o
      // efeito seria o produto inteiro passar a noite sem análise por causa de
      // um tenant.
      this.logger.warn(
        `analysis_scope.failed organizacao=${organizationId} motivo=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
