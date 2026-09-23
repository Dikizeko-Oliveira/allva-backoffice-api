import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { Integration } from 'src/modules/integrations/domain/entities';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  AdAccountsRepositoryInterface,
  IntegrationsRepositoryInterface,
} from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';

/** Por que a credencial saiu — fica na trilha, junto de quem a tirou. */
export type DisconnectionReason = 'USER_REQUEST' | 'ORGANIZATION_DELETED';

export type OrganizationDisconnectionOutcome = {
  /** Credenciais que saíram de conexão. */
  disconnected: number;
  /** Destas, as que a plataforma confirmou ter revogado. */
  revoked: number;
  /** As que não chegaram a ser desconectadas — falha de escrita, retentável. */
  failed: number;
};

/**
 * Desconectar uma credencial — o mesmo passo a passo em qualquer caminho.
 *
 * Existia só dentro de `DisconnectIntegrationUseCase`, amarrado ao escopo da
 * requisição. A exclusão da organização precisa exatamente da mesma sequência,
 * sem requisição nenhuma na mão, e duas cópias divergiriam no primeiro ajuste —
 * a trilha de uma diria `integration.disconnected` e a da outra, nada.
 */
@Injectable()
export class IntegrationDisconnectionService {
  private readonly logger = new Logger(IntegrationDisconnectionService.name);

  constructor(
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly auditLog: AuditLogService,
  ) {}

  async disconnect(
    integration: Integration,
    input: { actorId: string | null; reason: DisconnectionReason },
  ): Promise<{ revoked: boolean }> {
    const platform = integration.providerType as Platform;
    let revoked = true;

    try {
      await this.providers.for(platform).revokeToken(integration);
    } catch (error) {
      // Revogar na plataforma é o melhor esforço, não pré-requisito: a
      // plataforma fora do ar não pode manter a credencial conectada aqui. O
      // resultado vai para a trilha, que é onde se descobre um token que
      // continuou valendo do outro lado.
      revoked = false;
      this.logger.warn(
        `Provider revoke failed for ${platform} integration ${integration.id}: ${(error as Error).message}`,
      );
    }

    integration.markDisconnected();
    await this.integrationsRepository.update(integration);
    await this.adAccountsRepository.markIntegrationAccountsDisconnected(
      integration.id,
    );

    await this.auditLog.record({
      event: 'integration.disconnected',
      entityType: 'integration',
      entityId: integration.id,
      actorId: input.actorId,
      organizationId: integration.organizationId,
      metadata: { platform, reason: input.reason, revoked },
    });

    return { revoked };
  }

  /**
   * Toda credencial ainda conectada da organização — o caminho da exclusão.
   *
   * Uma credencial que falha não impede as outras: a exclusão já aconteceu, e
   * parar na primeira deixaria o resto dos tokens vivos por causa de um. A
   * falha volta contada, para quem chamou decidir se tenta de novo — as já
   * desconectadas são puladas na tentativa seguinte.
   */
  async disconnectOrganization(
    organizationId: string,
    actorId: string,
  ): Promise<OrganizationDisconnectionOutcome> {
    const outcome: OrganizationDisconnectionOutcome = {
      disconnected: 0,
      revoked: 0,
      failed: 0,
    };

    const linked =
      await this.integrationsRepository.listByOrganizationId(organizationId);

    for (const { integration } of linked) {
      // Já desconectada: o token foi revogado quando isso aconteceu.
      if (integration.status === 'DISCONNECTED') continue;

      try {
        const { revoked } = await this.disconnect(integration, {
          actorId,
          reason: 'ORGANIZATION_DELETED',
        });

        outcome.disconnected += 1;
        if (revoked) outcome.revoked += 1;
      } catch (error) {
        outcome.failed += 1;
        this.logger.error(
          `integration.disconnect_failed integrationId=${integration.id} ` +
            `organizationId=${organizationId}: ${(error as Error).message}`,
        );
      }
    }

    return outcome;
  }
}
