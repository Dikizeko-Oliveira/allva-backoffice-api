import { OrganizationInvitation } from '../entities';

export abstract class OrganizationInvitationsRepositoryInterface {
  abstract save(invitation: OrganizationInvitation): Promise<void>;
  abstract update(invitation: OrganizationInvitation): Promise<void>;
  abstract findById(id: string): Promise<OrganizationInvitation | null>;
  abstract findByTokenHash(
    tokenHash: string,
  ): Promise<OrganizationInvitation | null>;
  abstract findPendingByEmailAndOrganizationId(
    email: string,
    organizationId: string,
  ): Promise<OrganizationInvitation | null>;
  abstract listByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationInvitation[]>;
}
