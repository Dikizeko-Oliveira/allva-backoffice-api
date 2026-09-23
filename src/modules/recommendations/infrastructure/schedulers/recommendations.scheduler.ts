import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { RecommendationTargetsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendation-targets.repository';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { RecommendationsDispatcher } from '../queues/recommendations.dispatcher';

/**
 * Os ciclos de §8.8 — **rede de segurança, não gatilho principal**.
 *
 * A geração roda depois da detecção (07h00) e o ciclo de vida de hora em hora.
 * A ordem é presumida pelo relógio **só aqui**; a guarda de verdade está no
 * serviço, que recusa gerar quando a organização não tem conta saudável.
 *
 * **Os três só passam por organização com acesso aberto.** Sem acesso ninguém
 * vê a recomendação gerada, expirada ou medida — e quando o acesso volta, o
 * tick seguinte de cada um retoma de onde parou, porque tudo aqui é por data.
 */
@Injectable()
export class RecommendationsScheduler {
  private readonly logger = new Logger(RecommendationsScheduler.name);

  constructor(
    private readonly targets: RecommendationTargetsRepositoryInterface,
    private readonly dispatcher: RecommendationsDispatcher,
    private readonly env: EnvService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @Cron('0 7 * * *', {
    name: 'recommendations-generation',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async generateDaily(): Promise<void> {
    if (!this.env.get('RECOMMENDATION_ENGINE_ENABLED')) {
      this.logger.debug(
        'recommendations.disabled RECOMMENDATION_ENGINE_ENABLED=false',
      );
      return;
    }

    const ctx = createRootJobContext();
    const { kept: organizations, skipped } = await this.withOpenAccess(
      await this.targets.listOrganizationsToGenerate(),
    );

    for (const organizationId of organizations) {
      await this.dispatcher.generate({ ctx, organizationId });
    }

    this.logger.log(
      `recommendations.enqueued organizações=${organizations.length} ` +
        `fora_por_acesso=${skipped}`,
    );
  }

  /**
   * C5/⊕7 — roda **mesmo com o motor desligado**.
   *
   * A flag interrompe a **produção** de recomendações; a coerência do que já
   * está gravado continua sendo obrigação nossa. Amarrar o ciclo de vida à flag
   * faria desligar o motor significar também parar de expirar o que venceu — e
   * a tela continuaria oferecendo decisões sobre um mundo que não existe.
   *
   * Pelo mesmo motivo percorre organizações com **qualquer** conta, vinculada
   * ou não: é quando a integração cai que expirar o que venceu mais importa.
   */
  @Cron('15 * * * *', {
    name: 'recommendation-lifecycle',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async lifecycleHourly(): Promise<void> {
    const ctx = createRootJobContext();
    const { kept: organizations } = await this.withOpenAccess(
      await this.targets.listOrganizationsWithAdAccounts(),
    );

    for (const organizationId of organizations) {
      await this.dispatcher.lifecycle({ ctx, organizationId });
    }
  }

  /**
   * C4 — a medição da janela pós, **fora da flag do motor**.
   *
   * Pela mesma razão do ciclo de vida: `RECOMMENDATION_ENGINE_ENABLED` interrompe
   * a **produção** de recomendações. Medir o que já foi aplicado é obrigação
   * independente — desligar o motor não pode significar parar de registrar o
   * desfecho do que o usuário já executou, e é esse registro que P8 e §20-H3
   * consomem.
   *
   * **08h00, depois da geração das 07h.** Não porque dependa dela — não depende,
   * e `job-schedule.ts` diz por quê —, mas porque as duas leem a mesma base e
   * separá-las por uma hora evita que a organização grande as receba juntas.
   */
  @Cron('0 8 * * *', {
    name: 'recommendation-outcome-measure',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async measureOutcomesDaily(): Promise<void> {
    const ctx = createRootJobContext();
    const { kept: organizations } = await this.withOpenAccess(
      await this.targets.listOrganizationsWithAdAccounts(),
    );

    for (const organizationId of organizations) {
      await this.dispatcher.measureOutcomes({ ctx, organizationId });
    }

    this.logger.log(
      `recommendations.outcome_measure_enqueued organizações=${organizations.length}`,
    );
  }

  private withOpenAccess(organizationIds: string[]) {
    return this.sweep.keepByMode(organizationIds, (id) => id, ['FULL']);
  }
}
