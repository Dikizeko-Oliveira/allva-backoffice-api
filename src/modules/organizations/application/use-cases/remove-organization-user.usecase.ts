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
import { RemoveOrganizationUserOutputDto } from '../dtos';

type Actor = {
  organizationId: string;
  accountId: string;
  role: OrganizationRole;
};

@Injectable()
export class RemoveOrganizationUserUseCase {
  private readonly logger = new Logger(RemoveOrganizationUserUseCase.name);

  constructor(
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    actor: Actor,
    targetAccountId: string,
  ): Promise<RemoveOrganizationUserOutputDto> {
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

    // Anti-escalation: may only act on a strictly lower rank. This single rule
    // covers "admin cannot remove owner", "owner can remove admin" and blocks
    // peer-on-peer removal.
    if (rankOf(actor.role) <= rankOf(target.role)) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_REMOVE_USER',
        message: 'You cannot remove a member with an equal or higher role',
      });
    }

    if (target.isOwner()) {
      const activeOwners =
        await this.organizationUsersRepository.countActiveOwners(
          actor.organizationId,
        );

      if (activeOwners <= 1) {
        throw new ForbiddenException({
          code: 'CANNOT_REMOVE_LAST_OWNER',
          message: 'The last owner of the organization cannot be removed',
        });
      }
    }

    target.remove();
    await this.organizationUsersRepository.update(target);

    this.logger.log(
      `membership.removed organizationId=${actor.organizationId} targetAccountId=${targetAccountId} by=${actor.accountId}`,
    );

    await this.auditLog.record({
      event: 'member.removed',
      entityType: 'organization_user',
      entityId: target.id,
      actorId: actor.accountId,
      organizationId: actor.organizationId,
      metadata: { targetAccountId, role: target.role },
    });

    return { id: target.id, status: target.status };
  }
}
