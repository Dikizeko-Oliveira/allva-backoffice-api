import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { ListIntegrationsOutputDto } from '../dtos';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';

/**
 * As integrações que o **escopo da requisição** enxerga.
 *
 * A resolução de escopo saiu daqui e passou a ser a mesma de vincular,
 * desvincular e desconectar: `OwnerScopeResolverService`. A versão anterior
 * fazia a sua própria — organização do dono, senão a primeira participação — e
 * o resultado divergia da usada pelas escritas em dois pontos que o usuário
 * sente:
 *
 * - **Ignorava `X-Organization-Id`.** Quem participa de mais de uma organização
 *   trocava de workspace e continuava vendo as integrações da primeira, porque
 *   só esta leitura desconhecia a seleção da requisição.
 * - **Divergia das escritas.** Elas resolviam por `accountId`; esta, por
 *   organização. Para o dono os dois caminhos coincidem, e por isso o problema
 *   passou despercebido. Para um membro convidado, não: a lista mostrava a Meta
 *   como conectada e "Adicionar conta" respondia `INTEGRATION_NOT_CONNECTED` —
 *   a tela e a API discordando sobre a mesma credencial.
 */
@Injectable()
export class ListIntegrationsUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string): Promise<ListIntegrationsOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const owner = await this.ownerScope.resolveForAccount(accountId);
    const integrations = await this.ownerScope.listIntegrationsForOwner(owner);

    // A saúde de D17 numa consulta por integração, não por conta: a lista tem
    // poucas integrações e muitas contas, e uma consulta por conta traria de
    // volta o N+1 que a listagem não tem hoje.
    const healthByAccount = new Map(
      (
        await Promise.all(
          integrations.map((item) =>
            this.adAccountsRepository.listSyncHealthByIntegrationId(
              item.integration.id,
            ),
          ),
        )
      )
        .flat()
        .map((row) => [row.adAccountId, row]),
    );

    return {
      integrations: integrations.map((item) => {
        const i = item.integration.toJSON();
        return {
          id: i.id,
          platform: i.providerType,
          status: i.status,
          syncStatus: i.syncStatus,
          lastSyncAt: i.lastSyncAt ?? null,
          syncError: i.syncError ?? null,
          accounts: item.adAccounts.map((adAccount) => {
            const a = adAccount.toJSON();
            const health = healthByAccount.get(a.id);

            return {
              id: a.id,
              externalAccountId: a.externalAccountId,
              name: a.name,
              platform: i.providerType,
              currency: a.currency,
              timezone: a.timezone,
              isActive: a.active,
              frozenAt: a.frozenAt,
              syncHealth: health?.syncHealth ?? 'HEALTHY',
              syncHealthReason: health?.syncHealthReason ?? null,
              unreachableSince: health?.unreachableSince ?? null,
              lastSuccessfulFullSyncAt:
                health?.lastSuccessfulFullSyncAt ?? null,
            };
          }),
        };
      }),
    };
  }
}
