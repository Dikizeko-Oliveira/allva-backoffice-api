import { Injectable } from '@nestjs/common';
import {
  OrganizationUsersRepositoryInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { SubscriptionContextResolver } from 'src/modules/subscriptions/access/application/subscription-context.resolver';
import { ListMyOrganizationsItemDto } from '../dtos/list-my-organizations.dto';

/**
 * As organizações que a conta alcança — para o seletor do workspace.
 *
 * `GET /organizations` devolve **a** organização ativa com seus membros, e essa
 * assinatura não comporta a pergunta que o multi-organização criou: "entre
 * quais eu posso alternar?". Sobrecarregá-la faria a tela de membros carregar
 * uma lista que não usa, e o seletor depender do formato de outra tela.
 *
 * ## Posse e participação são caminhos diferentes
 *
 * Uma conta alcança uma organização por **possuí-la** (`ownerId`, quem criou) ou
 * por **participar** dela (`organization_users`). Os dois quase sempre coincidem
 * — criar já cria a participação OWNER —, mas não sempre: a transferência de
 * posse move `ownerId` sem remover o antigo dono da lista de membros, e um
 * convite aceito cria participação sem posse. Unir os dois conjuntos é o que
 * impede uma organização legítima de sumir do seletor por ter chegado pelo
 * caminho menos comum.
 */
@Injectable()
export class ListMyOrganizationsUseCase {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly subscriptions: SubscriptionContextResolver,
  ) {}

  async execute(accountId: string): Promise<ListMyOrganizationsItemDto[]> {
    const memberships =
      await this.organizationUsersRepository.listByAccountId(accountId);

    const roleByOrganization = new Map(
      memberships
        .filter((membership) => membership.isActive())
        .map((membership) => [membership.organizationId, membership.role]),
    );

    const owned = await this.organizationsRepository.listByOwnerId(accountId);

    const ids = [
      ...new Set([
        ...owned.map((organization) => organization.id),
        ...roleByOrganization.keys(),
      ]),
    ];

    if (ids.length === 0) return [];

    const organizations = await this.organizationsRepository.listByIds(ids);
    const ownedIds = new Set(owned.map((organization) => organization.id));

    /**
     * O status de cada uma, e não só o da ativa.
     *
     * Sem ele o seletor lista nomes e o usuário escolhe às cegas: trocar para
     * uma organização vencida faz o produto inteiro passar a recusar, sem que
     * a tela onde ele escolheu jamais tenha dito qual era o problema.
     *
     * Uma resolução por organização, em paralelo. É `O(n)` chamadas, e cabe:
     * a lista tem o tamanho de quantos workspaces uma pessoa acessa, não o do
     * banco — e ela só é buscada quando alguém abre o seletor.
     */
    const rows = await Promise.all(
      organizations.map(async (organization) => {
        const context = await this.subscriptions.resolve(accountId, {
          organizationId: organization.id,
        });

        return {
          id: organization.id,
          name: organization.name,
          isOwner: ownedIds.has(organization.id),
          // Dono sem participação ativa é estado degradado, não impossível: o
          // seletor precisa listá-lo assim mesmo, senão ele perderia acesso à
          // própria organização pela tela.
          role: roleByOrganization.get(organization.id) ?? null,
          accessStatus: context.accessStatus,
        };
      }),
    );

    return rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }
}
