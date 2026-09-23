import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import {
  COPY_STUDIO_QUEUE,
  LINK_APPLIED_COPY_JOB,
} from './copy-studio.constants';

/**
 * O que atravessa a fila até virar vínculo entre execução e variação.
 *
 * Carrega `JobContext` como toda fila da v2.0 (§5.6.2, ⊕16): a medição vai
 * perguntar, meses depois, qual sugestão produziu qual resultado, e a correlação
 * morre na primeira fronteira assíncrona se não viajar junto.
 *
 * **Dígito, nunca texto.** O que atravessa é a impressão digital do que foi ao
 * ar — conteúdo de marca do cliente não trafega em fila.
 */
export type LinkAppliedCopyJobData = {
  ctx: JobContext;
  organizationId: string;
  adId: string;
  contentDigest: string;
  executionId: string;
};

/**
 * A fronteira entre o barramento e a escrita do vínculo.
 *
 * `EventEmitter2` é **síncrono**: um handler que gravasse inline poria a
 * latência desta escrita dentro do emissor, e `perform-action` passaria a
 * esperar o Copy Studio para terminar de executar uma ação em mídia paga (⊕10).
 * O handler só enfileira; quem escreve é o worker.
 */
@Injectable()
export class CopyStudioDispatcher {
  constructor(@InjectQueue(COPY_STUDIO_QUEUE) private readonly queue: Queue) {}

  async linkApplied(
    data: LinkAppliedCopyJobData,
    jobId?: string,
  ): Promise<void> {
    await this.queue.add(LINK_APPLIED_COPY_JOB, data, {
      // Derivado da execução: a reentrega do mesmo evento colapsa no mesmo job.
      // O `update` do worker já é idempotente, e isto evita a ida ao banco.
      ...(jobId ? { jobId } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
