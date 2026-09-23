import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { JobCoordinatorService } from 'src/modules/sync/application/services/job-coordinator.service';
import type { JobOutcome } from 'src/modules/sync/application/services/job-coordinator.service';
import { GenerateRecommendationsService } from 'src/modules/recommendations/application/services/generate-recommendations.service';
import { RecommendationLifecycleService } from 'src/modules/recommendations/application/services/recommendation-lifecycle.service';
import { MeasureOutcomesService } from 'src/modules/recommendations/application/services/measure-outcomes.service';
import {
  GENERATE_RECOMMENDATIONS_JOB,
  MEASURE_OUTCOMES_JOB,
  RECOMMENDATIONS_QUEUE,
  RECOMMENDATION_LIFECYCLE_JOB,
} from './recommendations.constants';
import type { RecommendationsJobData } from './recommendations.dispatcher';

/**
 * Os dois jobs de `recommendations`, sob lease de `JobRun`.
 *
 * A geração **não declara `dependsOn`** e a razão está em `job-schedule.ts`: o
 * mecanismo de `JobRun` responde "esta conta terminou?", nunca "todas
 * terminaram?". A guarda equivalente vive no serviço e é mais forte — §9.4 passo
 * 1 recusa gerar sem conta saudável.
 */
@Processor(RECOMMENDATIONS_QUEUE)
export class RecommendationsWorker {
  private readonly logger = new Logger(RecommendationsWorker.name);

  constructor(
    private readonly coordinator: JobCoordinatorService,
    private readonly generation: GenerateRecommendationsService,
    private readonly lifecycle: RecommendationLifecycleService,
    private readonly measurement: MeasureOutcomesService,
  ) {}

  @Process(GENERATE_RECOMMENDATIONS_JOB)
  async generate(job: Job<RecommendationsJobData>): Promise<void> {
    const { ctx, organizationId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'recommendations-generation',
        scopeId: organizationId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard): Promise<JobOutcome> => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.generation.execute({
          organizationId,
          ctx,
          now,
        });

        // §9.4 passo 1 pausou: a janela é `SKIPPED` com o motivo, não
        // `SUCCEEDED`. `SUCCEEDED` nunca reexecuta, e marcar assim faria a pausa
        // virar um buraco permanente na geração daquele dia.
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
            successfulItems: result.persisted,
            failedItems: 0,
            result: {
              planned: result.planned,
              persisted: result.persisted,
              deferred: result.deferred,
              suppressed: result.suppressed,
              advisory: result.advisory,
              alreadyActive: result.alreadyActive,
            },
          },
        };
      },
    );

    this.logger.log(
      `recommendations.generation organizationId=${organizationId} outcome=${outcome.status}`,
    );
  }

  @Process(RECOMMENDATION_LIFECYCLE_JOB)
  async lifecycleTick(job: Job<RecommendationsJobData>): Promise<void> {
    const { ctx, organizationId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'recommendation-lifecycle',
        scopeId: organizationId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard): Promise<JobOutcome> => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.lifecycle.execute({
          organizationId,
          ctx,
          now,
        });

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.evaluated,
            successfulItems: result.expired + result.reactivated,
            failedItems: 0,
            result: {
              expired: result.expired,
              reactivated: result.reactivated,
              suppressionsPurged: result.suppressionsPurged,
            },
          },
        };
      },
    );

    this.logger.log(
      `recommendations.lifecycle organizationId=${organizationId} outcome=${outcome.status}`,
    );
  }

  /**
   * C4 — a medição da janela pós (A2-S9).
   *
   * **Nenhuma janela vira `SKIPPED` por não ter o que medir.** Zero linhas
   * pendentes é o caso normal na maioria dos dias, e marcar `SKIPPED` com
   * `EMPTY_WINDOW` encheria o histórico de `JobRun` de pulos que não são
   * anomalia nenhuma — e é `SKIPPED` que alguém olha quando investiga por que
   * algo não rodou.
   */
  @Process(MEASURE_OUTCOMES_JOB)
  async measureOutcomes(job: Job<RecommendationsJobData>): Promise<void> {
    const { ctx, organizationId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'recommendation-outcome-measure',
        scopeId: organizationId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard): Promise<JobOutcome> => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.measurement.execute({
          organizationId,
          ctx,
          now,
        });

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.evaluated,
            successfulItems: result.measured,
            failedItems: result.abandoned,
            result: {
              measured: result.measured,
              abandoned: result.abandoned,
              inconclusive: result.inconclusive,
            },
          },
        };
      },
    );

    this.logger.log(
      `recommendations.outcome_measure organizationId=${organizationId} outcome=${outcome.status}`,
    );
  }
}

/** O motivo da pausa, no vocabulário fechado de `JobSkipReason` (§4.7). */
function skipReasonOf(blockedReason: string) {
  if (blockedReason === 'CURRENCY_RECOMPUTING') return 'CURRENCY_RECOMPUTING';
  if (blockedReason === 'FEATURE_DISABLED') return 'FEATURE_DISABLED';
  return 'ACCOUNT_UNREACHABLE';
}
