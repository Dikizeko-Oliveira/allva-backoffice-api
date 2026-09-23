import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import {
  INTEGRATION_REVOCATION_QUEUE,
  REVOKE_ORGANIZATION_INTEGRATIONS_JOB,
} from './integration-revocation.constants';

/**
 * O que atravessa a fila até a revogação.
 *
 * Carrega `JobContext` como toda fila da v2.0: a desconexão que aparece na
 * trilha precisa ser rastreável até a exclusão que a causou.
 */
export type RevokeOrganizationIntegrationsJobData = {
  ctx: JobContext;
  organizationId: string;
  /** Quem excluiu a organização — a trilha registra a desconexão em nome dele. */
  actorId: string;
};

/**
 * A fronteira entre a exclusão da organização e a chamada às plataformas.
 *
 * `EventEmitter2` é síncrono: revogar inline poria a latência de três APIs
 * externas dentro da resposta do `DELETE` (⊕10). O handler só enfileira.
 */
@Injectable()
export class IntegrationRevocationDispatcher {
  constructor(
    @InjectQueue(INTEGRATION_REVOCATION_QUEUE) private readonly queue: Queue,
  ) {}

  async revokeForOrganization(
    data: RevokeOrganizationIntegrationsJobData,
    jobId?: string,
  ): Promise<void> {
    await this.queue.add(REVOKE_ORGANIZATION_INTEGRATIONS_JOB, data, {
      // `jobId` derivado do evento colapsa a reentrega no mesmo job.
      ...(jobId ? { jobId } : {}),
      // Só falha de escrita volta à fila — a recusa da plataforma não é
      // retentável e não chega aqui como erro.
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
