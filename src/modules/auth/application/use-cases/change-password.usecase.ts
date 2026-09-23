import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import {
  PasswordHasherInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { ChangePasswordOutputDto } from '../dtos/change-password.dto';
import { AuditLogService } from 'src/modules/audit/application';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly sessionsRepository: SessionsRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(params: {
    accountId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<ChangePasswordOutputDto> {
    const account = await this.accountsRepository.findById(params.accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const currentPasswordMatches = await this.passwordHasher.compare(
      params.currentPassword,
      account.passwordHash,
    );

    if (!currentPasswordMatches) {
      throw new UnauthorizedException({
        code: 'INVALID_CURRENT_PASSWORD',
        message: 'Current password is incorrect',
      });
    }

    const isSamePassword = await this.passwordHasher.compare(
      params.newPassword,
      account.passwordHash,
    );

    if (isSamePassword) {
      throw new ConflictException({
        code: 'SAME_PASSWORD',
        message: 'New password must be different from the current password',
      });
    }

    const newPasswordHash = await this.passwordHasher.hash(params.newPassword);

    await this.accountsRepository.updatePassword(
      params.accountId,
      newPasswordHash,
    );
    await this.sessionsRepository.revokeAllByAccountId(params.accountId);

    const { subject, html, text } = await this.emailTemplates.render(
      'password-changed',
      {
        name: account.name,
      },
    );

    await this.emailSender.send({ to: account.email, subject, html, text });

    // Recorded after sessions are revoked, so the trail reflects the completed
    // operation rather than an intent.
    await this.auditLog.record({
      event: 'account.password_changed',
      entityType: 'account',
      entityId: params.accountId,
      actorId: params.accountId,
    });

    return { success: true, message: 'Password changed successfully.' };
  }
}
