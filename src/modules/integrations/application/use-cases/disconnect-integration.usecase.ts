import { Injectable, NotFoundException } from '@nestjs/common';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { DisconnectIntegrationResponseDto } from '../dtos';
import { IntegrationDisconnectionService } from '../services/integration-disconnection.service';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';

@Injectable()
export class DisconnectIntegrationUseCase {
  constructor(
    private readonly disconnection: IntegrationDisconnectionService,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  async execute(
    accountId: string,
    platform: Platform,
  ): Promise<DisconnectIntegrationResponseDto> {
    // Mesmo escopo de `ListIntegrations`: desconectar o que a tela mostra.
    const owner = await this.ownerScope.resolveForAccount(accountId);
    const integration = await this.ownerScope.findIntegrationForOwner(
      owner,
      platform,
    );

    if (!integration) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_FOUND',
        message: `No ${platform} integration for this account`,
      });
    }

    await this.disconnection.disconnect(integration, {
      actorId: accountId,
      reason: 'USER_REQUEST',
    });

    return { id: integration.id, status: integration.status };
  }
}
