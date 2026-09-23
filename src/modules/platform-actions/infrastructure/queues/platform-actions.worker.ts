import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PerformActionService } from 'src/modules/platform-actions/application/services/perform-action.service';
import { ReapExpiredExecutionsService } from 'src/modules/platform-actions/application/services/reap-expired-executions.service';
import { VerifyActionService } from 'src/modules/platform-actions/application/services/verify-action.service';
import { JobCoordinatorService } from 'src/modules/sync/application/services/job-coordinator.service';
import { SyncDispatcher } from 'src/modules/sync/infrastructure/queues/sync.dispatcher';
import {
  PERFORM_ACTION_JOB,
  PLATFORM_ACTIONS_QUEUE,
  REAP_EXECUTIONS_JOB,
  VERIFY_ACTION_JOB,
} from './platform-actions.constants';
import { PlatformActionsDispatcher } from './platform-actions.dispatcher';
import type {
  PerformActionJobData,
  ReapExecutionsJobData,
  VerifyActionJobData,
} from './platform-actions.dispatcher';

/**
 * O worker de escrita (§13.4).
 *
 * **Ele não decide nada** — os serviços decidem, e o worker traduz o veredito em
 * próximo passo na fila. É o que mantém a lógica testável sem Redis, e o que
 * impede a política de retry de virar configuração de broker.
 *
 * **Quando uma escrita termina sem confirmar, o worker pede ao `sync` que releia
 * o anúncio.** §3.5 não deixa `platform-actions` sair de `PENDING_WRITE`, e a
 * razão é boa: quem afirma o que a plataforma tem é quem a lê. Sem esse pedido,
 * porém, o anúncio ficaria em "pausando…" até o ingest horário passar — e depois
 * de uma recusa, "pausando…" é a informação errada por até uma hora.
 */
@Processor(PLATFORM_ACTIONS_QUEUE)
export class PlatformActionsWorker {
  private readonly logger = new Logger(PlatformActionsWorker.name);

  constructor(
    private readonly performAction: PerformActionService,
    private readonly verifyAction: VerifyActionService,
    private readonly reaper: ReapExpiredExecutionsService,
    private readonly dispatcher: PlatformActionsDispatcher,
    private readonly sync: SyncDispatcher,
    private readonly coordinator: JobCoordinatorService,
  ) {}

  @Process(PERFORM_ACTION_JOB)
  async handlePerform(job: Job<PerformActionJobData>): Promise<void> {
    const { ctx, executionId, attempt } = job.data;

    const outcome = await this.performAction.perform({
      executionId,
      attempt,
      ctx,
    });

    if (outcome.kind === 'RETRY') {
      await this.dispatcher.performLater(
        { ctx, executionId, attempt: attempt + 1 },
        outcome.delayMs,
      );
      return;
    }

    if (outcome.kind === 'VERIFY') {
      await this.dispatcher.verify({ ctx, executionId }, outcome.delayMs);
      return;
    }

    if (outcome.kind === 'SKIPPED') {
      this.logger.debug(
        `action.perform_skipped execution=${executionId} motivo=${outcome.reason}`,
      );
      return;
    }

    // Terminou sem escrita confirmada: o anúncio precisa de leitura fresca.
    await this.requestRefresh(ctx, outcome);
  }

  @Process(VERIFY_ACTION_JOB)
  async handleVerify(job: Job<VerifyActionJobData>): Promise<void> {
    const { ctx, executionId } = job.data;

    const outcome = await this.verifyAction.verify({ executionId, ctx });

    if (outcome.kind === 'RETRY') {
      await this.dispatcher.verify({ ctx, executionId }, outcome.delayMs);
      return;
    }

    if (outcome.kind === 'DONE') {
      /**
       * Confirmado, divergente ou não verificado — nos três casos o `sync`
       * relê. Confirmado porque só ele pode mover `PENDING_WRITE → IN_SYNC`;
       * os outros dois porque são exatamente os casos em que o que sabemos
       * sobre o anúncio é menos confiável.
       */
      await this.requestRefresh(ctx, outcome);
    }
  }

  @Process(REAP_EXECUTIONS_JOB)
  async handleReap(job: Job<ReapExecutionsJobData>): Promise<void> {
    const now = new Date();

    /**
     * Sob lease de `JobRun`, como todo job de §8.8. Duas réplicas varrendo a
     * mesma janela recolheriam as mesmas execuções e gravariam auditoria em
     * dobro — e a trilha de escrita em mídia paga é a que menos pode ter
     * linhas duplicadas de origem desconhecida.
     */
    await this.coordinator.runUnderLease(
      {
        jobName: 'action-execution-reaper',
        scopeId: 'GLOBAL',
        now,
        correlationId: job.data.ctx.correlationId,
      },
      async () => {
        const { reaped } = await this.reaper.reap(now);

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: reaped,
            successfulItems: reaped,
            failedItems: 0,
            result: { reaped },
          },
        };
      },
    );
  }

  /** Pede ao `sync` a releitura do anúncio — ele é o dono de `syncState`. */
  private async requestRefresh(
    ctx: PerformActionJobData['ctx'],
    settled: { organizationId: string; adId: string },
  ): Promise<void> {
    await this.sync.refresh({
      ctx,
      organizationId: settled.organizationId,
      adIds: [settled.adId],
    });
  }
}
