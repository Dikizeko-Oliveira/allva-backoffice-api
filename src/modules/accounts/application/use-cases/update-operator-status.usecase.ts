import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { isPlatformRole } from 'src/modules/accounts/domain/platform-rbac';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  UpdateOperatorStatusInputDto,
  UpdateOperatorStatusOutputDto,
} from 'src/modules/accounts/application/dtos';

@Injectable()
export class UpdateOperatorStatusUseCase {
  private readonly logger = new Logger(UpdateOperatorStatusUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    targetId: string,
    dto: UpdateOperatorStatusInputDto,
    actorId: string,
  ): Promise<UpdateOperatorStatusOutputDto> {
    await this.platformRole.assertPermission(actorId, 'users:manage');

    const target = await this.accountsRepository.findById(targetId);

    if (!target) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    if (!isPlatformRole(target.role)) {
      throw new BadRequestException({
        code: 'NOT_A_PLATFORM_ACCOUNT',
        message: 'Esta conta não é de operador.',
      });
    }

    const result = await this.accountsRepository.changePlatformStatus(
      targetId,
      dto.status,
      actorId,
      dto.reason,
    );

    if (result.outcome === 'LAST_ADMIN') {
      throw new ConflictException({
        code: 'LAST_PLATFORM_ADMIN',
        message:
          'Esta é a única conta de administração ativa. Promova ou reative outra antes de suspender esta.',
      });
    }

    if (result.outcome === 'UPDATED') {
      await this.audit.record({
        event: 'account.platform_status.updated',
        entityType: 'account',
        entityId: targetId,
        actorId,
        organizationId: null,
        metadata: {
          from: result.previousStatus,
          to: dto.status,
          reason: dto.reason,
        },
      });

      this.logger.log(
        `platform_status.updated target=${targetId} actor=${actorId} from=${result.previousStatus} to=${dto.status}`,
      );
    }

    return { id: targetId, status: dto.status };
  }
}
