import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import { AD_SCORING_QUEUE, SCORE_AD_ACCOUNT_JOB } from './ad-scoring.constants';

/** Todo payload de fila carrega `JobContext` (§5.6.2, ⊕16). */
export type ScoreAdAccountJobData = {
  ctx: JobContext;
  adAccountId: string;
};

@Injectable()
export class AdScoringDispatcher {
  constructor(@InjectQueue(AD_SCORING_QUEUE) private readonly queue: Queue) {}

  async score(data: ScoreAdAccountJobData): Promise<void> {
    await this.queue.add(SCORE_AD_ACCOUNT_JOB, data, {
      // Um pedido por conta por dia colapsa na fila; o lease de `JobRun` é a
      // garantia de verdade, esta é só a barata.
      jobId: `${SCORE_AD_ACCOUNT_JOB}:${data.adAccountId}:${new Date().toISOString().slice(0, 10)}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
