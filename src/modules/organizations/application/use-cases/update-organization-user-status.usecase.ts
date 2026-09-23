import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationUserStatus } from 'src/modules/organizations/domain/entities';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import {
  OrganizationRole,
  rankOf,
} from 'src/modules/organizations/domain/rbac';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  UpdateOrganizationUserStatusInputDto,
  UpdateOrganizationUserStatusOutputDto,
} from '../dtos';

type Actor = {
  organizationId: string;
  accountId: string;
  role: OrganizationRole;
};

@Injectable()
export class UpdateOrganizationUserStatusUseCase {
  private readonly logger = new Logger(
    UpdateOrganizationUserStatusUseCase.name,
  );

  constructor(
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    actor: Actor,
    targetAccountId: string,
    input: UpdateOrganizationUserStatusInputDto,
  ): Promise<UpdateOrganizationUserStatusOutputDto> {
    const newStatus = input.status as unknown as OrganizationUserStatus;

    const target =
      await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        actor.organizationId,
        targetAccountId,
      );

    if (!target) {
      throw new NotFoundException({
        code: 'ORGANIZATION_USER_NOT_FOUND',
        message: 'Organization user not found',
      });
    }

    // Anti-escalation: may only act on a strictly lower rank.
    if (rankOf(actor.role) <= rankOf(target.role)) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_UPDATE_STATUS',
        message: 'You cannot change the status of an equal or higher member',
      });
    }

    // Don't let the org lose its last active owner via block/remove.
    const removesActiveOwner =
      target.isOwner() &&
      target.isActive() &&
      (newStatus === 'BLOCKED' || newStatus === 'REMOVED');

    if (removesActiveOwner) {
      const activeOwners =
        await this.organizationUsersRepository.countActiveOwners(
          actor.organizationId,
        );

      if (activeOwners <= 1) {
        throw new ForbiddenException({
          code: 'CANNOT_DEACTIVATE_LAST_OWNER',
          message: 'The last active owner cannot be blocked or removed',
        });
      }
    }

    // Route through the entity methods that also maintain the deleted_at mark
    // (REMOVED stamps it, ACTIVE clears it) so soft-delete stays consistent.
    if (newStatus === 'REMOVED') {
      target.remove();
    } else if (newStatus === 'ACTIVE') {
      target.activate();
    } else {
      target.updateStatus(newStatus);
    }

    await this.organizationUsersRepository.update(target);

    this.logger.log(
      `membership.status_updated organizationId=${actor.organizationId} targetAccountId=${targetAccountId} status=${newStatus} by=${actor.accountId}`,
    );

    await this.auditLog.record({
      event:
        newStatus === 'REMOVED' ? 'member.removed' : 'member.status.updated',
      entityType: 'organization_user',
      entityId: target.id,
      actorId: actor.accountId,
      organizationId: actor.organizationId,
      metadata: { targetAccountId, status: newStatus },
    });

    return { id: target.id, status: target.status };
  }
}
