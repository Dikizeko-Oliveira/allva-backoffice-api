import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import {
  DETECT_WASTE_JOB,
  RECONCILE_DENORMALIZATION_JOB,
  WASTE_QUEUE,
} from './waste.constants';

/** Todo payload de fila carrega `JobContext` (§5.6.2, ⊕16). */
export type WasteJobData = {
  ctx: JobContext;
  adAccountId: string;
};

@Injectable()
export class WasteDispatcher {
  constructor(@InjectQueue(WASTE_QUEUE) private readonly queue: Queue) {}

  /**
   * `delayMs` existe para a cadeia da primeira sincronização, que precisa dar
   * folga ao `ad-scoring` do qual este job depende. No ciclo diário é ausente.
   */
  async detect(data: WasteJobData, delayMs?: number): Promise<void> {
    await this.enqueue(DETECT_WASTE_JOB, data, delayMs);
  }

  async reconcile(data: WasteJobData, delayMs?: number): Promise<void> {
    await this.enqueue(RECONCILE_DENORMALIZATION_JOB, data, delayMs);
  }

  private async enqueue(
    name: string,
    data: WasteJobData,
    delayMs?: number,
  ): Promise<void> {
    await this.queue.add(name, data, {
      ...(delayMs ? { delay: delayMs } : {}),
      // Um pedido por conta por dia colapsa na fila. O lease de `JobRun` é a
      // garantia de verdade; esta é a barata, e ela existe para o caso comum não
      // chegar ao banco duas vezes.
      jobId: `${name}:${data.adAccountId}:${new Date().toISOString().slice(0, 10)}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
