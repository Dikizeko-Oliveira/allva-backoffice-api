import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { AdvanceContractLifecycleUseCase } from 'src/modules/contracts/application/use-cases/advance-contract-lifecycle.usecase';
import { ApplyDueAmendmentsUseCase } from 'src/modules/contracts/application/use-cases/apply-due-amendments.usecase';

export const CONTRACT_LIFECYCLE_QUEUE = 'contract-lifecycle';
export const CONTRACT_LIFECYCLE_JOB = 'advance-contracts';

type ContractLifecycleJobData = {
  limit?: number;
};

/**
 * O que passa sozinho na vida de um contrato.
 *
 * Fila própria, e não uma etapa da reconciliação de billing: aquela roda de
 * cinco em cinco minutos atrás da Stripe, e o contrato se move em dias — data
 * de vigência que chega, aditivo que passa a valer, atraso que estoura a
 * tolerância. Pendurar um no outro faria a carteira Enterprise inteira ser
 * varrida 288 vezes por dia para mudar nada.
 */
@Processor(CONTRACT_LIFECYCLE_QUEUE)
export class ContractLifecycleProcessor {
  private readonly logger = new Logger(ContractLifecycleProcessor.name);

  constructor(
    private readonly applyAmendments: ApplyDueAmendmentsUseCase,
    private readonly advanceLifecycle: AdvanceContractLifecycleUseCase,
  ) {}

  @Process(CONTRACT_LIFECYCLE_JOB)
  async handle(job: Job<ContractLifecycleJobData>) {
    this.logger.log(`Running contract lifecycle job=${job.id}`);

    /**
     * Aditivos primeiro, e a ordem é deliberada: um aditivo que baixa o valor
     * negociado muda o que o cliente deve, e avaliar a inadimplência antes dele
     * suspenderia um contrato que a renegociação acabou de acertar.
     */
    const amendments = await this.applyAmendments.execute({
      limit: job.data.limit,
    });
    const lifecycle = await this.advanceLifecycle.execute({
      limit: job.data.limit,
    });

    return { amendmentsApplied: amendments.applied, ...lifecycle };
  }
}
