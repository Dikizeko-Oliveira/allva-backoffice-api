import { randomBytes } from 'crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { Account } from 'src/modules/accounts/domain/entities';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { PasswordResetToken } from 'src/modules/auth/domain/entities';
import {
  PasswordHasherInterface,
  PasswordResetTokensRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { permissionsForRole } from 'src/modules/accounts/domain/platform-rbac';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';
import {
  CreateOperatorInputDto,
  CreateOperatorOutputDto,
} from 'src/modules/accounts/application/dtos';

@Injectable()
export class CreateOperatorUseCase {
  private readonly logger = new Logger(CreateOperatorUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly resetTokensRepository: PasswordResetTokensRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly appUrl: AppUrlService,
    private readonly platformRole: PlatformRoleService,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    dto: CreateOperatorInputDto,
    actorId: string,
  ): Promise<CreateOperatorOutputDto> {
    await this.platformRole.assertPermission(
      actorId,
      'users:manage_platform_role',
    );

    const existing = await this.accountsRepository.findByEmail(dto.email);

    if (existing) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'Account already exists',
      });
    }

    const passwordHash = await this.passwordHasher.hash(
      randomBytes(64).toString('hex'),
    );

    const account = Account.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
      role: dto.platformRole,
      emailVerified: true,
    });

    await this.accountsRepository.save(account);
    await this.sendPasswordSetupEmail(account);

    await this.audit.record({
      event: 'account.created',
      entityType: 'account',
      entityId: account.id,
      actorId,
      organizationId: null,
      metadata: {
        method: 'platform_operator_invite',
        platformRole: dto.platformRole,
      },
    });

    this.logger.log(
      `operator.created accountId=${account.id} actor=${actorId} role=${dto.platformRole}`,
    );

    return {
      id: account.id,
      name: account.name,
      email: account.email,
      platformRole: dto.platformRole,
      platformPermissions: permissionsForRole(dto.platformRole),
      status: 'ACTIVE',
    };
  }

  private async sendPasswordSetupEmail(account: Account): Promise<void> {
    await this.resetTokensRepository.invalidateAllByAccountId(account.id);

    const token = randomBytes(32).toString('hex');
    const tokenHash = await this.passwordHasher.hash(token);

    await this.resetTokensRepository.create(
      PasswordResetToken.create({
        accountId: account.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      }),
    );

    const resetUrl = this.appUrl.pathTo(`auth/reset-password?token=${token}`);

    const { subject, html, text } = await this.emailTemplates.render(
      'forgot-password',
      {
        name: account.name,
        resetUrl,
      },
    );

    await this.emailSender.send({
      to: account.email,
      subject,
      html,
      text,
    });
  }
}
