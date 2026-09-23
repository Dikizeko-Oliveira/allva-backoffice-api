import { OrganizationUser } from '../entities';

export abstract class OrganizationUsersRepositoryInterface {
  abstract save(organizationUser: OrganizationUser): Promise<void>;
  abstract update(organizationUser: OrganizationUser): Promise<void>;
  abstract findById(id: string): Promise<OrganizationUser | null>;
  /**
   * Returns a single membership for the account, preferring ACTIVE ones. Kept
   * for owner-centric flows that predate multi-org; new multi-tenant code
   * should use findByOrganizationIdAndAccountId instead.
   */
  abstract findByAccountId(accountId: string): Promise<OrganizationUser | null>;
  abstract findByOrganizationIdAndAccountId(
    organizationId: string,
    accountId: string,
  ): Promise<OrganizationUser | null>;
  abstract listByAccountId(accountId: string): Promise<OrganizationUser[]>;
  abstract listByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationUser[]>;
  abstract countActiveOwners(organizationId: string): Promise<number>;
}
