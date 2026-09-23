import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { WasteTargetsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-targets.repository';
import { WasteDispatcher } from '../queues/waste.dispatcher';

/**
 * Os dois ciclos diários de §8.8, enfileirados — **rede de segurança, não
 * gatilho principal**.
 *
 * A detecção roda depois do scoring (05h30) e a reconciliação depois da
 * detecção; mas as duas dependências são verificadas no worker, por consulta a
 * `JobRun`, e não presumidas pelo horário. Um cron que confia no relógio quebra
 * silenciosamente no dia em que a conta grande demora vinte minutos a mais — e
 * quebra pontuando desperdício sobre score que não existe.
 *
 * **Os dois só passam por organização com acesso aberto.** Nenhum produz nada
 * sem o scoring do dia, e o scoring já não roda para quem perdeu acesso:
 * enfileirá-los seria só gravar `SKIPPED` em `job_runs`.
 */
@Injectable()
export class WasteScheduler {
  private readonly logger = new Logger(WasteScheduler.name);

  constructor(
    private readonly targets: WasteTargetsRepositoryInterface,
    private readonly dispatcher: WasteDispatcher,
    private readonly env: EnvService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @Cron('0 6 * * *', { name: 'waste-detection', timeZone: SCHEDULER_TIMEZONE })
  async detectDaily(): Promise<void> {
    if (!this.env.get('WASTE_DETECTOR_V2_ENABLED')) {
      this.logger.debug('waste.disabled WASTE_DETECTOR_V2_ENABLED=false');
      return;
    }

    const ctx = createRootJobContext();
    const { kept, skipped } = await this.sweep.keepByMode(
      await this.targets.listAccountsToDetect(),
      (account) => account.organizationId,
      ['FULL'],
    );

    for (const account of kept) {
      await this.dispatcher.detect({ ctx, adAccountId: account.adAccountId });
    }

    this.logger.log(
      `waste.detection_enqueued contas=${kept.length} fora_por_acesso=${skipped}`,
    );
  }

  /**
   * C3 — roda mesmo com o detector desligado.
   *
   * A flag interrompe a **produção** de achados; a coerência do que já está
   * gravado continua sendo obrigação nossa. Amarrar a reconciliação à flag faria
   * desligar o detector significar também parar de conferir os números que a
   * tela continua mostrando.
   */
  @Cron('30 6 * * *', {
    name: 'denormalization-reconcile',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async reconcileDaily(): Promise<void> {
    const ctx = createRootJobContext();
    const { kept, skipped } = await this.sweep.keepByMode(
      await this.targets.listAccountsToDetect(),
      (account) => account.organizationId,
      ['FULL'],
    );

    for (const account of kept) {
      await this.dispatcher.reconcile({
        ctx,
        adAccountId: account.adAccountId,
      });
    }

    this.logger.log(
      `waste.reconcile_enqueued contas=${kept.length} fora_por_acesso=${skipped}`,
    );
  }
}
