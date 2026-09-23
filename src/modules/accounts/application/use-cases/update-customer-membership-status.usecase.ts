import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import {
  UpdateCustomerMembershipStatusInputDto,
  UpdateCustomerMembershipStatusOutputDto,
} from 'src/modules/accounts/application/dtos';

@Injectable()
export class UpdateCustomerMembershipStatusUseCase {
  private readonly logger = new Logger(
    UpdateCustomerMembershipStatusUseCase.name,
  );

  constructor(
    private readonly platformRole: PlatformRoleService,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    accountId: string,
    organizationId: string,
    dto: UpdateCustomerMembershipStatusInputDto,
    actorId: string,
  ): Promise<UpdateCustomerMembershipStatusOutputDto> {
    await this.platformRole.assertPermission(actorId, 'users:manage');

    const target =
      await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        organizationId,
        accountId,
      );

    if (!target || target.isDeleted()) {
      throw new NotFoundException({
        code: 'ORGANIZATION_USER_NOT_FOUND',
        message: 'Organization user not found',
      });
    }

    const previousStatus = target.status;

    if (target.isOwner() && target.isActive() && dto.status === 'BLOCKED') {
      const activeOwners =
        await this.organizationUsersRepository.countActiveOwners(
          organizationId,
        );

      if (activeOwners <= 1) {
        throw new ConflictException({
          code: 'CANNOT_DEACTIVATE_LAST_OWNER',
          message: 'The last active owner cannot be blocked',
        });
      }
    }

    if (dto.status === 'ACTIVE') {
      target.activate();
    } else {
      target.block();
    }

    await this.organizationUsersRepository.update(target);

    if (previousStatus !== target.status) {
      await this.audit.record({
        event: 'member.status.updated',
        entityType: 'organization_user',
        entityId: target.id,
        actorId,
        organizationId,
        metadata: {
          targetAccountId: accountId,
          from: previousStatus,
          to: target.status,
          reason: dto.reason,
          source: 'platform_admin',
        },
      });

      this.logger.log(
        `customer_membership.status_updated organizationId=${organizationId} targetAccountId=${accountId} from=${previousStatus} to=${target.status} by=${actorId}`,
      );
    }

    return { id: target.id, status: target.status as 'ACTIVE' | 'BLOCKED' };
  }
}
