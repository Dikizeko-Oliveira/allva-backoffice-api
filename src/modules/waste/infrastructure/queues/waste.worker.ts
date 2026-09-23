import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { JobCoordinatorService } from 'src/modules/sync/application/services/job-coordinator.service';
import type { JobOutcome } from 'src/modules/sync/application/services/job-coordinator.service';
import { DetectWasteService } from 'src/modules/waste/application/services/detect-waste.service';
import { WasteReconciliationService } from 'src/modules/waste/application/services/waste-reconciliation.service';
import {
  DETECT_WASTE_JOB,
  RECONCILE_DENORMALIZATION_JOB,
  WASTE_QUEUE,
} from './waste.constants';
import type { WasteJobData } from './waste.dispatcher';

/**
 * Os dois jobs diários de `waste`, sob lease de `JobRun`.
 *
 * **A dependência de §8.8 é resolvida por consulta, não por horário.**
 * `waste-detection` depende de `ad-scoring` ter tido `SUCCEEDED` na janela do
 * dia: quatro dos dez detectores leem componentes do `AdScore`, e rodar antes
 * deles produziria `MISSING_SCORE` em massa — insuficiência fabricada pela ordem
 * de execução, não pelo dado.
 */
@Processor(WASTE_QUEUE)
export class WasteWorker {
  private readonly logger = new Logger(WasteWorker.name);

  constructor(
    private readonly coordinator: JobCoordinatorService,
    private readonly detection: DetectWasteService,
    private readonly reconciliation: WasteReconciliationService,
  ) {}

  @Process(DETECT_WASTE_JOB)
  async detect(job: Job<WasteJobData>): Promise<void> {
    const { ctx, adAccountId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'waste-detection',
        scopeId: adAccountId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard): Promise<JobOutcome> => {
        const ready = await this.coordinator.upstreamReady({
          jobName: 'waste-detection',
          scopeId: adAccountId,
          now,
        });

        if (!ready) return { status: 'SKIPPED', reason: 'UPSTREAM_NOT_READY' };
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.detection.execute({ adAccountId, ctx, now });

        // §8.7 ou §10.7 passo 1 pausaram: a janela é `SKIPPED` com o motivo, e
        // não `SUCCEEDED`. Marcá-la como bem-sucedida diria que a conta foi
        // varrida — e `SUCCEEDED` nunca reexecuta, então a pausa viraria um
        // buraco permanente na detecção daquele dia.
        if (result.blockedReason) {
          return {
            status: 'SKIPPED',
            reason: skipReasonOf(result.blockedReason),
          };
        }

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.adsEvaluated,
            successfulItems: result.findings,
            failedItems: 0,
            result: {
              findings: result.findings,
              created: result.created,
              resolved: result.resolved,
              insufficient: result.insufficient,
            },
          },
        };
      },
    );

    this.logger.log(
      `waste.detection adAccountId=${adAccountId} outcome=${outcome.status}`,
    );
  }

  /**
   * C3 — a reconciliação das denormalizações.
   *
   * Depende de `waste-detection` da mesma janela: comparar a coluna com a
   * agregação **antes** de o ciclo do dia gravar acusaria como divergência o
   * atraso normal de um dia.
   */
  @Process(RECONCILE_DENORMALIZATION_JOB)
  async reconcile(job: Job<WasteJobData>): Promise<void> {
    const { ctx, adAccountId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'denormalization-reconcile',
        scopeId: adAccountId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard): Promise<JobOutcome> => {
        const ready = await this.coordinator.upstreamReady({
          jobName: 'denormalization-reconcile',
          scopeId: adAccountId,
          now,
        });

        if (!ready) return { status: 'SKIPPED', reason: 'UPSTREAM_NOT_READY' };
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.reconciliation.execute({
          adAccountId,
          ctx,
          now,
        });

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.adsChecked,
            successfulItems: result.corrected,
            failedItems: 0,
            result: { corrected: result.corrected },
          },
        };
      },
    );

    this.logger.log(
      `waste.reconcile adAccountId=${adAccountId} outcome=${outcome.status}`,
    );
  }
}

/**
 * O motivo da pausa, no vocabulário fechado de `JobSkipReason` (§4.7).
 *
 * `NO_VALID_OBSERVATION` mapeia para `ACCOUNT_UNREACHABLE`: do ponto de vista do
 * job, não houve leitura válida da conta — que é exatamente o que o valor
 * significa. Um valor novo aqui exigiria alterar o vocabulário compartilhado por
 * todos os jobs para dizer a mesma coisa com outra palavra.
 */
function skipReasonOf(blockedReason: string) {
  if (blockedReason === 'CURRENCY_RECOMPUTING') return 'CURRENCY_RECOMPUTING';
  return 'ACCOUNT_UNREACHABLE';
}
