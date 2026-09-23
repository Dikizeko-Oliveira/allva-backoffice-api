import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ScoreAdAccountService } from 'src/modules/ad-scoring/application/services/score-ad-account.service';
import { JobCoordinatorService } from 'src/modules/sync/application/services/job-coordinator.service';
import { AD_SCORING_QUEUE, SCORE_AD_ACCOUNT_JOB } from './ad-scoring.constants';
import type { ScoreAdAccountJobData } from './ad-scoring.dispatcher';

/**
 * O ciclo diário de scoring, sob lease de `JobRun`.
 *
 * **A dependência de §8.8 é resolvida por consulta, não por horário.**
 * `ad-scoring` depende de `ads-ingest-full` ter tido `SUCCEEDED` na janela do
 * dia: pontuar sobre uma ingestão que não terminou produz score sobre série
 * incompleta, e a queda que ele reporta é da leitura, não da mídia. Ausente ⇒
 * `SKIPPED` com `UPSTREAM_NOT_READY`, sem erro — a cadeia por evento é o caminho
 * normal e o cron é rede de segurança.
 */
@Processor(AD_SCORING_QUEUE)
export class AdScoringWorker {
  private readonly logger = new Logger(AdScoringWorker.name);

  constructor(
    private readonly coordinator: JobCoordinatorService,
    private readonly scoring: ScoreAdAccountService,
  ) {}

  @Process(SCORE_AD_ACCOUNT_JOB)
  async handle(job: Job<ScoreAdAccountJobData>): Promise<void> {
    const { ctx, adAccountId } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: 'ad-scoring',
        scopeId: adAccountId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        const ready = await this.coordinator.upstreamReady({
          jobName: 'ad-scoring',
          scopeId: adAccountId,
          now,
        });

        if (!ready) {
          return { status: 'SKIPPED', reason: 'UPSTREAM_NOT_READY' };
        }

        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.scoring.execute({ adAccountId, ctx, now });

        // §8.7 pausou: a janela é `SKIPPED` com o motivo, e não `SUCCEEDED`.
        // Marcá-la como bem-sucedida diria que a conta foi pontuada — e
        // `SUCCEEDED` nunca reexecuta, então a pausa viraria um buraco.
        if (result.blockedReason) {
          return {
            status: 'SKIPPED',
            reason:
              result.blockedReason === 'CURRENCY_RECOMPUTING'
                ? 'CURRENCY_RECOMPUTING'
                : 'ACCOUNT_UNREACHABLE',
          };
        }

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.scored + result.skippedByDigest,
            successfulItems: result.scored,
            failedItems: 0,
            result: {
              scored: result.scored,
              skippedByDigest: result.skippedByDigest,
              frozen: result.frozen,
            },
          },
        };
      },
    );

    this.logger.log(
      `ad_scoring.window adAccountId=${adAccountId} outcome=${outcome.status}`,
    );
  }
}
