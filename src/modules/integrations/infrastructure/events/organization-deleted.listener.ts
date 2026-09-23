import { Injectable } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import {
  OnDomainEvent,
  jobIdFor,
} from 'src/shared/infrastructure/events/on-domain-event.decorator';
import { IntegrationRevocationDispatcher } from '../queues/integration-revocation.dispatcher';

/**
 * A organização foi excluída: as credenciais dela saem de conexão.
 *
 * Consumidor de evento puro, como `alerts` e `onboarding-chain`: `organizations`
 * não pode chamar `integrations` sem fechar ciclo de módulo. E só enfileira —
 * revogar é chamar três APIs externas, e o emissor é a resposta de um `DELETE`.
 */
@Injectable()
export class OrganizationDeletedListener {
  constructor(private readonly dispatcher: IntegrationRevocationDispatcher) {}

  @OnDomainEvent('organization.deleted')
  async onOrganizationDeleted(
    event: DomainEvent<'organization.deleted'>,
  ): Promise<void> {
    await this.dispatcher.revokeForOrganization(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        actorId: event.payload.actorId,
      },
      jobIdFor(event),
    );
  }
}
