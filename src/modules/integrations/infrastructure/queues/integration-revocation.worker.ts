import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { IntegrationDisconnectionService } from 'src/modules/integrations/application/services/integration-disconnection.service';
import {
  INTEGRATION_REVOCATION_QUEUE,
  REVOKE_ORGANIZATION_INTEGRATIONS_JOB,
} from './integration-revocation.constants';
import type { RevokeOrganizationIntegrationsJobData } from './integration-revocation.dispatcher';

/** Onde as credenciais de uma organização excluída são de fato revogadas. */
@Processor(INTEGRATION_REVOCATION_QUEUE)
export class IntegrationRevocationWorker {
  private readonly logger = new Logger(IntegrationRevocationWorker.name);

  constructor(
    private readonly disconnection: IntegrationDisconnectionService,
  ) {}

  @Process(REVOKE_ORGANIZATION_INTEGRATIONS_JOB)
  async handle(job: Job<RevokeOrganizationIntegrationsJobData>): Promise<void> {
    const { ctx, organizationId, actorId } = job.data;

    const outcome = await this.disconnection.disconnectOrganization(
      organizationId,
      actorId,
    );

    this.logger.log(
      `integration.organization_revoked organizationId=${organizationId} ` +
        `desconectadas=${outcome.disconnected} revogadas=${outcome.revoked} ` +
        `falhas=${outcome.failed} correlationId=${ctx.correlationId}`,
    );

    // Falha de escrita volta à fila: a tentativa seguinte pula o que já saiu
    // de conexão. A recusa da plataforma não entra aqui — não há o que retentar.
    if (outcome.failed > 0) {
      throw new Error(
        `${outcome.failed} credencial(is) da organização ${organizationId} não foram desconectadas`,
      );
    }
  }
}
