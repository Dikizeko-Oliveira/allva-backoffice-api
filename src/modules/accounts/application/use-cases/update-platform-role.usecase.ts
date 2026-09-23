import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  isPlatformRole,
  permissionsForRole,
} from 'src/modules/accounts/domain/platform-rbac';
import { PlatformRoleService } from '../services/platform-role.service';
import {
  UpdatePlatformRoleInputDto,
  UpdatePlatformRoleOutputDto,
} from '../dtos';

/**
 * `PATCH /api/v1/admin/accounts/:id/platform-role` — B3 do mapa de endpoints.
 *
 * Até aqui conceder papel de plataforma era `UPDATE` no banco: sem trilha,
 * sem guarda e sem ninguém conseguir dizer depois quem deu poder a quem.
 *
 * ## Três regras, e a razão de cada uma
 *
 * **Só `users:manage_platform_role`**, que só a administração tem. É a única
 * permissão que se auto-multiplica: quem concede papel concede o poder de
 * conceder.
 *
 * **O alvo já precisa ser operador.** Esta rota muda alguém de área; ela não
 * transforma cliente em operador. Isso é o convite de operador (B19), com
 * token e senha definida pelo próprio titular — promover uma conta de
 * cliente por aqui daria acesso de plataforma a alguém que nunca aceitou ser
 * operador, com a senha que ele usa no produto.
 *
 * **Nunca sem administrador.** Rebaixar o último `ALLVA_ADMIN` deixaria a
 * plataforma sem ninguém capaz de conceder papel de novo — irrecuperável sem
 * banco. O invariante é garantido no repositório, sob trava, porque uma
 * checagem aqui perderia para duas requisições simultâneas.
 */
@Injectable()
export class UpdatePlatformRoleUseCase {
  private readonly logger = new Logger(UpdatePlatformRoleUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    targetId: string,
    dto: UpdatePlatformRoleInputDto,
    actorId: string,
  ): Promise<UpdatePlatformRoleOutputDto> {
    await this.platformRole.assertPermission(
      actorId,
      'users:manage_platform_role',
    );

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
        message:
          'Esta conta não é de operador. Para dar acesso ao painel, convide-a como operador.',
      });
    }

    const result = await this.accountsRepository.changePlatformRole(
      targetId,
      dto.platformRole,
    );

    if (result.outcome === 'LAST_ADMIN') {
      throw new ConflictException({
        code: 'LAST_PLATFORM_ADMIN',
        message:
          'Esta é a única conta de administração. Promova outra antes de mudar esta.',
      });
    }

    if (result.outcome === 'UPDATED') {
      await this.audit.record({
        event: 'account.platform_role.updated',
        entityType: 'account',
        entityId: targetId,
        actorId,
        // Papel de plataforma não pertence a organização nenhuma.
        organizationId: null,
        metadata: { from: result.previousRole, to: dto.platformRole },
      });

      this.logger.log(
        `platform_role.updated target=${targetId} actor=${actorId} ` +
          `from=${result.previousRole} to=${dto.platformRole}`,
      );
    }

    return {
      id: target.id,
      name: target.name,
      email: target.email,
      platformRole: dto.platformRole,
      platformPermissions: permissionsForRole(dto.platformRole),
    };
  }
}
