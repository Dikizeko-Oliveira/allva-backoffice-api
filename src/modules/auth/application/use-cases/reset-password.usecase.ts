import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import {
  PasswordHasherInterface,
  PasswordResetTokensRepositoryInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { BruteForceProtectionService } from 'src/modules/security/application';

@Injectable()
export class ResetPasswordUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly resetTokensRepository: PasswordResetTokensRepositoryInterface,
    private readonly sessionsRepository: SessionsRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly bruteForce: BruteForceProtectionService,
  ) {}

  async execute(params: {
    token: string;
    newPassword: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const bruteForceKey = {
      scope: 'password_reset' as const,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    };

    // Token-guessing protection: lock out IPs hammering reset tokens.
    await this.bruteForce.assertNotLocked(bruteForceKey);

    const tokenEntity = await this.resetTokensRepository.findValidByToken(
      params.token,
    );

    if (!tokenEntity) {
      // registerFailure records `password.reset.failed`; response stays generic.
      await this.bruteForce.registerFailure(bruteForceKey);
      throw new UnauthorizedException({
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Reset token is invalid or expired',
      });
    }

    const passwordHash = await this.passwordHasher.hash(params.newPassword);

    await this.accountsRepository.updatePassword(
      tokenEntity.accountId,
      passwordHash,
    );

    await this.sessionsRepository.revokeAllByAccountId(tokenEntity.accountId);

    tokenEntity.markAsUsed();

    await this.resetTokensRepository.invalidate(tokenEntity.id);

    const account = await this.accountsRepository.findById(
      tokenEntity.accountId,
    );

    if (account) {
      const { subject, html, text } = await this.emailTemplates.render(
        'password-changed',
        {
          name: account.name,
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
}
