import { Injectable, NotFoundException } from '@nestjs/common';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { ListExternalAdAccountsResponseDto } from '../dtos';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';

/**
 * O catálogo de contas que a credencial conectada expõe.
 *
 * Resolve a integração pelo **mesmo escopo da listagem** (§`ListIntegrations`).
 * Buscar por `accountId`, como antes, fazia este endpoint responder 404 para
 * qualquer membro que não fosse quem conectou — o modal "Adicionar conta"
 * abrindo em "Erro ao carregar contas" numa plataforma que a tela ao fundo
 * mostra como conectada.
 */
@Injectable()
export class ListPlatformAdAccountsUseCase {
  constructor(
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  async execute(
    accountId: string,
    platform: Platform,
  ): Promise<ListExternalAdAccountsResponseDto> {
    const owner = await this.ownerScope.resolveForAccount(accountId);
    const integration = await this.ownerScope.findIntegrationForOwner(
      owner,
      platform,
    );

    if (!integration || !integration.isConnected()) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_CONNECTED',
        message: `No connected ${platform} integration for this account`,
      });
    }

    const [remoteAccounts, linkedAccounts] = await Promise.all([
      this.providers.for(platform).listAdAccounts(integration),
      this.adAccountsRepository.listByIntegrationId(integration.id),
    ]);

    const activeById = new Map(
      linkedAccounts
        .filter((a) => a.isActive())
        .map((a) => [a.externalAccountId, a.id]),
    );

    return {
      accounts: remoteAccounts.map((account) => {
        const linkedId = activeById.get(account.externalAccountId) ?? null;
        return {
          externalAccountId: account.externalAccountId,
          name: account.name,
          currency: account.currency,
          timezone: account.timezone,
          status: account.status ?? 'UNKNOWN',
          linked: linkedId !== null,
          linkedId,
        };
      }),
    };
  }
}
