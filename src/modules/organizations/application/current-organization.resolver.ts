import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Organization } from 'src/modules/organizations/domain/entities';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { OrganizationRole } from 'src/modules/organizations/domain/rbac';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';

export type CurrentOrganization = {
  organization: Organization;
  accountId: string;
  /** The caller's effective role in `organization`. */
  role: OrganizationRole;
  /** `null` for an owner whose membership row predates owner memberships. */
  membershipId: string | null;
};

/**
 * The organization a request is acting on.
 *
 * Reads and writes in this module used to disagree about that. The member
 * mutations resolved the organization from `X-Organization-Id` (via
 * `OrganizationAccessGuard`), while reading the organization, updating it and
 * every invitation route re-derived it from the account alone — owned org first,
 * otherwise whichever membership came back first.
 *
 * For an account in one organization the two paths coincide and nothing showed.
 * For an account that owns A and administers B they diverged silently: the screen
 * listed A's members while a role change landed on B. A write to the wrong tenant,
 * with no error anywhere.
 *
 * This resolves it once, the same way for every route: honour the selected
 * organization when the header named one, fall back to the previous behaviour when
 * it did not — so a client that sends no header keeps working exactly as before.
 */
@Injectable()
export class CurrentOrganizationResolver {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly requestContext: RequestContextService,
  ) {}

  async resolve(accountId: string): Promise<CurrentOrganization> {
    const selected = this.requestContext.getOrganizationId();

    return selected
      ? this.resolveSelected(accountId, selected)
      : this.resolveDefault(accountId);
  }

  /**
   * `OrganizationContextMiddleware` already validated access before publishing the
   * id, so this re-check is belt-and-braces — but it is also where the caller's
   * role comes from, and background callers never reach here at all.
   */
  private async resolveSelected(
    accountId: string,
    organizationId: string,
  ): Promise<CurrentOrganization> {
    const [organization, membership] = await Promise.all([
      this.organizationsRepository.findById(organizationId),
      this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        organizationId,
        accountId,
      ),
    ]);

    const isOwner = organization?.ownerId === accountId;
    const hasActiveMembership = Boolean(membership?.isActive());

    // One generic error for "no such organization" and "not yours alike", so the
    // header cannot be used to probe which organizations exist.
    if (!organization || (!isOwner && !hasActiveMembership)) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_ACCESS_DENIED',
        message: 'You do not have access to this organization',
      });
    }

    return {
      organization,
      accountId,
      role: membership?.role ?? 'OWNER',
      membershipId: membership?.id ?? null,
    };
  }

  /**
   * No header: the account's own organization, else the first membership found.
   * Unchanged from what each use case did inline — the point of this branch is to
   * keep existing clients behaving identically, not to improve on them.
   */
  private async resolveDefault(
    accountId: string,
  ): Promise<CurrentOrganization> {
    const owned = await this.organizationsRepository.findByOwnerId(accountId);

    if (owned) {
      const membership =
        await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
          owned.id,
          accountId,
        );

      return {
        organization: owned,
        accountId,
        role: membership?.role ?? 'OWNER',
        membershipId: membership?.id ?? null,
      };
    }

    const membership =
      await this.organizationUsersRepository.findByAccountId(accountId);

    const organization = membership
      ? await this.organizationsRepository.findById(membership.organizationId)
      : null;

    if (!membership || !organization) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return {
      organization,
      accountId,
      role: membership.role,
      membershipId: membership.id,
    };
  }

  /**
   * Whether the caller may manage members and invitations.
   *
   * Kept here next to the resolution it depends on: each invitation use case used
   * to rebuild this from an `isOwner || isPrivilegedMember` pair whose membership
   * could belong to a different organization than the one being acted on.
   */
  canManageMembers(current: CurrentOrganization): boolean {
    return (
      current.organization.ownerId === current.accountId ||
      current.role === 'OWNER' ||
      current.role === 'ADMIN'
    );
  }
}
