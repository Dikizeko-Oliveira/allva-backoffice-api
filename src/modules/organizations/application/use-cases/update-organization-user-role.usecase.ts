import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import {
  OrganizationRole,
  rankOf,
} from 'src/modules/organizations/domain/rbac';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  UpdateOrganizationUserRoleInputDto,
  UpdateOrganizationUserRoleOutputDto,
} from '../dtos';

type Actor = {
  organizationId: string;
  accountId: string;
  role: OrganizationRole;
};

@Injectable()
export class UpdateOrganizationUserRoleUseCase {
  private readonly logger = new Logger(UpdateOrganizationUserRoleUseCase.name);

  constructor(
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    actor: Actor,
    targetAccountId: string,
    input: UpdateOrganizationUserRoleInputDto,
  ): Promise<UpdateOrganizationUserRoleOutputDto> {
    const newRole = input.role as unknown as OrganizationRole;

    const target =
      await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        actor.organizationId,
        targetAccountId,
      );

    if (!target || target.status === 'REMOVED') {
      throw new NotFoundException({
        code: 'ORGANIZATION_USER_NOT_FOUND',
        message: 'Organization user not found',
      });
    }

    // May only manage a strictly lower rank than your own...
    if (rankOf(actor.role) <= rankOf(target.role)) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_UPDATE_ROLE',
        message: 'You cannot change the role of an equal or higher member',
      });
    }

    // ...and may never grant a role with rank >= your own (prevents privilege
    // escalation and makes minting a new OWNER via this endpoint impossible).
    if (rankOf(newRole) >= rankOf(actor.role)) {
      throw new ForbiddenException({
        code: 'ROLE_ESCALATION_NOT_ALLOWED',
        message: 'You cannot assign a role equal to or higher than your own',
      });
    }

    // Demoting the last active owner would leave the org ownerless.
    if (target.isOwner() && newRole !== 'OWNER') {
      const activeOwners =
        await this.organizationUsersRepository.countActiveOwners(
          actor.organizationId,
        );

      if (activeOwners <= 1) {
        throw new ForbiddenException({
          code: 'CANNOT_DEMOTE_LAST_OWNER',
          message: 'The last owner of the organization cannot be demoted',
        });
      }
    }

    target.updateRole(newRole);
    await this.organizationUsersRepository.update(target);

    this.logger.log(
      `membership.role_updated organizationId=${actor.organizationId} targetAccountId=${targetAccountId} role=${newRole} by=${actor.accountId}`,
    );

    await this.auditLog.record({
      event: 'member.role.updated',
      entityType: 'organization_user',
      entityId: target.id,
      actorId: actor.accountId,
      organizationId: actor.organizationId,
      metadata: { targetAccountId, role: newRole },
    });

    return { id: target.id, role: target.role };
  }
}
