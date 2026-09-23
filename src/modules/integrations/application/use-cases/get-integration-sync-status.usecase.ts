import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AdAccountsRepositoryInterface,
  IntegrationsRepositoryInterface,
} from 'src/modules/integrations/domain/ports';
import {
  Platform,
  platformToProviderType,
} from 'src/modules/integrations/domain/entities/platform';
import { SyncStatusResponseDto } from '../dtos';

@Injectable()
export class GetIntegrationSyncStatusUseCase {
  constructor(
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
  ) {}

  async execute(
    accountId: string,
    platform: Platform,
  ): Promise<SyncStatusResponseDto> {
    const integration =
      await this.integrationsRepository.findByAccountAndProvider(
        accountId,
        platformToProviderType(platform),
      );

    if (!integration) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_FOUND',
        message: `No ${platform} integration for this account`,
      });
    }

    const [adAccounts, health] = await Promise.all([
      this.adAccountsRepository.listByIntegrationId(integration.id),
      this.adAccountsRepository.listSyncHealthByIntegrationId(integration.id),
    ]);

    const healthByAccount = new Map(
      health.map((row) => [row.adAccountId, row]),
    );

    return {
      platform,
      status: integration.status,
      syncStatus: integration.syncStatus,
      lastSyncAt: integration.lastSyncAt ?? null,
      syncError: integration.syncError ?? null,
      accounts: adAccounts.map((adAccount) => {
        const accountHealth = healthByAccount.get(adAccount.id);

        return {
          id: adAccount.id,
          externalAccountId: adAccount.externalAccountId,
          name: adAccount.name,
          platform,
          currency: adAccount.currency,
          timezone: adAccount.timezone,
          isActive: adAccount.isActive(),
          frozenAt: adAccount.frozenAt,
          // Conta recém-vinculada ainda não passou por ingest: `HEALTHY` é o
          // default da coluna, e é a leitura certa — não há falha observada.
          syncHealth: accountHealth?.syncHealth ?? 'HEALTHY',
          syncHealthReason: accountHealth?.syncHealthReason ?? null,
          unreachableSince: accountHealth?.unreachableSince ?? null,
          lastSuccessfulFullSyncAt:
            accountHealth?.lastSuccessfulFullSyncAt ?? null,
        };
      }),
    };
  }
}
