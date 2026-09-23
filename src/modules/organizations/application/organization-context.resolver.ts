import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { OrganizationRole } from 'src/modules/organizations/domain/rbac';

export type OrganizationContext = {
  organizationId: string;
  accountId: string;
  /**
   * `null` para dono cuja participação OWNER falta — o estado degradado que
   * `CurrentOrganizationResolver` já documentava com o mesmo tipo. Era `string`
   * aqui, e a única forma de honrar isso seria `''`, que passa por qualquer
   * checagem de presença enquanto não identifica participação nenhuma.
   */
  membershipId: string | null;
  role: OrganizationRole;
};

@Injectable()
export class OrganizationContextResolver {
  constructor(
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
  ) {}

  /**
   * Resolves and authorizes the current-organization context for an account.
   * The account must hold an ACTIVE membership in the target organization;
   * anything else (no membership, INVITED/BLOCKED/REMOVED) is denied with a
   * single generic error so the header cannot be used to probe membership.
   */
  async resolve(
    accountId: string,
    organizationId: string,
  ): Promise<OrganizationContext> {
    const membership =
      await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        organizationId,
        accountId,
      );

    if (!membership || !membership.isActive()) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_ACCESS_DENIED',
        message: 'You do not have access to this organization',
      });
    }

    return {
      organizationId,
      accountId,
      membershipId: membership.id,
      role: membership.role,
    };
  }

  /**
   * A organização em que a conta age quando a requisição não nomeou nenhuma.
   *
   * Existia um buraco aqui: sem `X-Organization-Id`, o middleware declarava
   * workspace PERSONAL, enquanto `CurrentOrganizationResolver.resolveDefault` e
   * `OwnerScopeResolverService.resolveDefaultScope` — os dois resolvedores que o
   * resto do produto usa — caíam na organização padrão da conta. Três respostas
   * para "onde estou", e a do middleware era a que alimentava `GET /auth/me`.
   *
   * O efeito era visível: a tela de organização recebia os dados (`GET
   * /organizations` responde 200, porque usa o resolvedor que acerta) e não os
   * renderizava, porque `permissions` vinha com o conjunto pessoal —
   * `manage_personal_billing` e companhia —, sem nenhuma permissão de
   * organização. Dados sem autoridade para exibi-los: skeleton eterno.
   *
   * `isActive()` aqui, e não `status === 'ACTIVE'`: este contexto alimenta
   * guards e o tenant do banco, então participação congelada por teto de
   * assentos **não** pode conceder acesso. É a assimetria deliberada com
   * `OrganizationProvisioningService`, onde a pergunta era "pertence" e o
   * congelado contava.
   *
   * `null` quando a conta não alcança nenhuma organização. Deixou de acontecer
   * no cadastro, que agora provisiona uma; continua possível para conta legada
   * que o backfill não alcançou, e nesse caso o chamador mantém o comportamento
   * anterior em vez de inventar acesso.
   */
  async resolveDefault(accountId: string): Promise<OrganizationContext | null> {
    const memberships = (
      await this.organizationUsersRepository.listByAccountId(accountId)
    ).filter((membership) => membership.isActive());

    // A participação sobrevive ao soft delete da organização, então a existência
    // de uma não prova a da outra.
    const alive = new Set(
      (
        await this.organizationsRepository.listByIds(
          memberships.map((membership) => membership.organizationId),
        )
      ).map((organization) => organization.id),
    );

    const membership = memberships.find((candidate) =>
      alive.has(candidate.organizationId),
    );

    if (membership) {
      return {
        organizationId: membership.organizationId,
        accountId,
        membershipId: membership.id,
        role: membership.role,
      };
    }

    /**
     * Posse sem participação é estado degradado — o `membershipId: null` que
     * `CurrentOrganizationResolver` documenta em dado legado. Continua sendo
     * atendido para a conta não perder acesso à própria organização por causa de
     * uma linha que faltou, com o mesmo papel presumido que aquele resolvedor
     * usa. `saveWithOwner` e o teste de invariante impedem novos.
     */
    const owned = await this.organizationsRepository.findByOwnerId(accountId);

    if (!owned) return null;

    return {
      organizationId: owned.id,
      accountId,
      membershipId: null,
      role: 'OWNER',
    };
  }
}
