import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { CopyGenerationsRepositoryInterface } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import {
  COPY_STUDIO_QUEUE,
  LINK_APPLIED_COPY_JOB,
} from './copy-studio.constants';
import type { LinkAppliedCopyJobData } from './copy-studio.dispatcher';

/**
 * Onde o vínculo entre a execução e a variação é de fato gravado.
 *
 * **É a peça que fecha o laço da Allva.** Sem ela, o produto vai de anúncio a
 * recomendação e para; com ela, chega a *"a variação B rendeu 18% mais CTR que
 * a original"* — porque a série de score atravessa a recriação pela linhagem, e
 * o que faltava era saber qual texto foi ao ar.
 *
 * O casamento é por **dígito**, e o silêncio quando nada casa é correto: uma
 * ação com texto digitado à mão não tem variação por trás, e carimbar a
 * selecionada mais próxima faria a medição atribuir à Allva um texto que ela
 * não escreveu.
 */
@Processor(COPY_STUDIO_QUEUE)
export class CopyStudioWorker {
  private readonly logger = new Logger(CopyStudioWorker.name);

  constructor(
    private readonly generations: CopyGenerationsRepositoryInterface,
  ) {}

  @Process(LINK_APPLIED_COPY_JOB)
  async handle(job: Job<LinkAppliedCopyJobData>): Promise<void> {
    const { ctx, ...input } = job.data;

    await this.generations.linkApplied({
      organizationId: input.organizationId,
      adId: input.adId,
      contentDigest: input.contentDigest,
      executionId: input.executionId,
      appliedAt: new Date(),
    });

    this.logger.log(
      `copy.applied_link_attempted adId=${input.adId} ` +
        `executionId=${input.executionId} correlationId=${ctx.correlationId}`,
    );
  }
}
