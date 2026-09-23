import { Injectable } from '@nestjs/common';
import {
  ListOrganizationInvitationsOutputDto,
  OrganizationInvitationItemDto,
} from '../dtos';
import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import { OrganizationInvitationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { OrganizationContext } from '../organization-context.resolver';

/**
 * Autorização no `OrganizationAccessGuard` (`members:invite`), como em envio e
 * revogação — ver `SendOrganizationInvitationUseCase` para o motivo de não
 * resolver a organização de novo a partir da conta.
 */
@Injectable()
export class ListOrganizationInvitationsUseCase {
  constructor(
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
  ) {}

  async execute(
    actor: OrganizationContext,
  ): Promise<ListOrganizationInvitationsOutputDto> {
    const invitations = await this.invitationsRepository.listByOrganizationId(
      actor.organizationId,
    );

    return {
      invitations: invitations.map((invitation) => this.toItem(invitation)),
    };
  }

  private toItem(
    invitation: OrganizationInvitation,
  ): OrganizationInvitationItemDto {
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: this.resolveStatus(invitation),
      invitedBy: invitation.invitedBy,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
    };
  }

  private resolveStatus(
    invitation: OrganizationInvitation,
  ): 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' {
    if (invitation.isAccepted()) return 'ACCEPTED';
    if (invitation.isRevoked()) return 'REVOKED';
    if (invitation.isExpired()) return 'EXPIRED';
    return 'PENDING';
  }
}
