import { Injectable } from '@nestjs/common';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';

export type OwnerScope = {
  accountId: string;
  organizationId: string | null;
};

@Injectable()
export class OwnerScopeResolverService {
  constructor(
    private readonly orgUsers: OrganizationUsersRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
  ) {}

  /**
   * Resolves the owning scope for a user.
   *
   * When the request selected an organization via X-Organization-Id (passed
   * explicitly or read from the per-request context), that org is honored after
   * re-validating the account's access to it — so a multi-org account sees the
   * org it asked for, not an arbitrary one (A-6). Otherwise it falls back to a
   * default: an ACTIVE membership, then an owned organization, then the
   * account-level scope. Background jobs pass nothing and have no request
   * context, so they resolve the default.
   */
  async resolveForAccount(
    accountId: string,
    selectedOrganizationId?: string,
  ): Promise<OwnerScope> {
    const selected =
      selectedOrganizationId ?? this.requestContext.getOrganizationId();

    if (selected) {
      const scoped = await this.resolveSelectedOrganization(
        accountId,
        selected,
      );
      // A resolvable selection wins. An unresolvable one (stale/forged id that
      // bypassed the middleware) falls through to the default rather than leak.
      if (scoped) return scoped;
    }

    return this.resolveDefaultScope(accountId);
  }

  private async resolveSelectedOrganization(
    accountId: string,
    organizationId: string,
  ): Promise<OwnerScope | null> {
    const membership = await this.orgUsers.findByOrganizationIdAndAccountId(
      organizationId,
      accountId,
    );
    if (membership && membership.isActive()) {
      return { accountId, organizationId };
    }

    const ownedOrganizationId = await this.findOwnedOrganizationId(accountId);
    if (ownedOrganizationId === organizationId) {
      return { accountId, organizationId };
    }

    return null;
  }

  private async resolveDefaultScope(accountId: string): Promise<OwnerScope> {
    const membership = await this.orgUsers.findByAccountId(accountId);
    if (membership && membership.isActive() && membership.organizationId) {
      return { accountId, organizationId: membership.organizationId };
    }

    const ownedOrganizationId = await this.findOwnedOrganizationId(accountId);
    if (ownedOrganizationId) {
      return { accountId, organizationId: ownedOrganizationId };
    }

    return { accountId, organizationId: null };
  }

  private async findOwnedOrganizationId(
    accountId: string,
  ): Promise<string | null> {
    /**
     * `findFirst` com ordem explícita, e sem `as never`.
     *
     * Era `findUnique({ where: { ownerId } })`, que só compilava porque os casts
     * desligavam a checagem — e foi exatamente o que escondeu esta linha quando
     * `owner_id` deixou de ser único. Sem os casts, o compilador aponta;
     * com eles, o Prisma recusaria o `where` em runtime.
     *
     * A ordem é o que torna a escolha determinística agora que a conta pode
     * possuir várias: a organização mais antiga é a de referência, e não "a que
     * o banco devolver primeiro".
     */
    const owned = await this.prisma.organization.findFirst({
      where: { ownerId: accountId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    return owned?.id ?? null;
  }

  async findIntegrationForOwner(
    owner: OwnerScope,
    platform: Platform,
  ): Promise<Integration | null> {
    if (owner.organizationId) {
      const list = await this.integrations.listByOrganizationId(
        owner.organizationId,
      );
      const found = list.find((i) => i.integration.providerType === platform);
      return found?.integration ?? null;
    }
    const list = await this.integrations.listByAccountId(owner.accountId);
    const found = list.find((i) => i.integration.providerType === platform);
    return found?.integration ?? null;
  }

  async listIntegrationsForOwner(owner: OwnerScope) {
    if (owner.organizationId) {
      return this.integrations.listByOrganizationId(owner.organizationId);
    }
    return this.integrations.listByAccountId(owner.accountId);
  }

  /**
   * Returns true if the integration is accessible by this owner scope.
   */
  isIntegrationOwned(owner: OwnerScope, integration: Integration): boolean {
    if (integration.organizationId) {
      return integration.organizationId === owner.organizationId;
    }
    return integration.accountId === owner.accountId;
  }
}
