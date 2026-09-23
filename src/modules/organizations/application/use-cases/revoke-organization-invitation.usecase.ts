import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RevokeOrganizationInvitationOutputDto } from '../dtos';
import { OrganizationInvitationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { rankOf } from 'src/modules/organizations/domain/rbac';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { OrganizationContext } from '../organization-context.resolver';

@Injectable()
export class RevokeOrganizationInvitationUseCase {
  private readonly logger = new Logger(
    RevokeOrganizationInvitationUseCase.name,
  );

  constructor(
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    invitationId: string,
    actor: OrganizationContext,
  ): Promise<RevokeOrganizationInvitationOutputDto> {
    const invitation = await this.invitationsRepository.findById(invitationId);

    // Scope check prevents revoking invitations from other organizations and
    // avoids leaking their existence (same NOT_FOUND for both cases).
    if (!invitation || invitation.organizationId !== actor.organizationId) {
      throw new NotFoundException({
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation not found',
      });
    }

    /**
     * Revogar é desfazer uma concessão, e segue a regra de conceder: só abaixo
     * do próprio rank. Sem isto um ADMIN derrubava o convite de ADMIN que o OWNER
     * tinha emitido — a decisão de quem está acima dele.
     */
    if (rankOf(invitation.role) >= rankOf(actor.role)) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_REVOKE_INVITATION',
        message:
          'You cannot revoke an invitation for a role equal to or higher than your own',
      });
    }

    if (invitation.isAccepted()) {
      throw new BadRequestException({
        code: 'INVITATION_ALREADY_ACCEPTED',
        message: 'An accepted invitation cannot be revoked',
      });
    }

    if (invitation.isRevoked()) {
      throw new BadRequestException({
        code: 'INVITATION_ALREADY_REVOKED',
        message: 'Invitation has already been revoked',
      });
    }

    // Soft-revoke: never physically delete, just stamp revoked_at.
    invitation.revoke();
    await this.invitationsRepository.update(invitation);

    this.logger.log(
      `invitation.revoked invitationId=${invitation.id} organizationId=${actor.organizationId} revokedBy=${actor.accountId}`,
    );

    await this.auditLog.record({
      event: 'invitation.revoked',
      entityType: 'organization_invitation',
      entityId: invitation.id,
      actorId: actor.accountId,
      organizationId: actor.organizationId,
      metadata: { email: invitation.email },
    });

    return {
      id: invitation.id,
      revokedAt: invitation.revokedAt as Date,
    };
  }
}
