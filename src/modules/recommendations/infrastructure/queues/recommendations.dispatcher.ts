import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import {
  GENERATE_RECOMMENDATIONS_JOB,
  MEASURE_OUTCOMES_JOB,
  RECOMMENDATIONS_QUEUE,
  RECOMMENDATION_LIFECYCLE_JOB,
} from './recommendations.constants';

/** Todo payload de fila carrega `JobContext` (§5.6.2, ⊕16). */
export type RecommendationsJobData = {
  ctx: JobContext;
  organizationId: string;
};

@Injectable()
export class RecommendationsDispatcher {
  constructor(
    @InjectQueue(RECOMMENDATIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * `delayMs` existe para a cadeia da primeira sincronização, que precisa dar
   * folga aos achados de desperdício. No ciclo diário é ausente.
   */
  async generate(
    data: RecommendationsJobData,
    delayMs?: number,
  ): Promise<void> {
    await this.enqueue(GENERATE_RECOMMENDATIONS_JOB, data, 'daily', delayMs);
  }

  async lifecycle(data: RecommendationsJobData): Promise<void> {
    // Horário, não diário (§8.8): a reabilitação de uma diferida depende de a
    // vencedora ter sido aplicada, e esperar até a madrugada deixaria o problema
    // fora da tela por um dia inteiro depois de o conflito cessar.
    await this.enqueue(RECOMMENDATION_LIFECYCLE_JOB, data, 'hourly');
  }

  /**
   * C4 — diário, e **sem depender da geração**.
   *
   * Medir o que já foi aplicado não precisa de recomendação nova: amarrar os
   * dois faria uma organização com o motor desligado parar de medir o que ela
   * aplicou enquanto ele estava ligado.
   */
  async measureOutcomes(data: RecommendationsJobData): Promise<void> {
    await this.enqueue(MEASURE_OUTCOMES_JOB, data, 'daily');
  }

  private async enqueue(
    name: string,
    data: RecommendationsJobData,
    cadence: 'daily' | 'hourly',
    delayMs?: number,
  ): Promise<void> {
    const stamp =
      cadence === 'daily'
        ? new Date().toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 13);

    await this.queue.add(name, data, {
      ...(delayMs ? { delay: delayMs } : {}),
      // O lease de `JobRun` é a garantia de verdade; esta é a barata, e existe
      // para o caso comum não chegar ao banco duas vezes.
      jobId: `${name}:${data.organizationId}:${stamp}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
