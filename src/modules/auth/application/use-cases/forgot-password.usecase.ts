import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import { PasswordResetToken } from 'src/modules/auth/domain/entities';
import {
  PasswordHasherInterface,
  PasswordResetTokensRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { SecurityAuditLogService } from 'src/modules/security/application';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';

type ForgotPasswordContext = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class ForgotPasswordUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly resetTokensRepository: PasswordResetTokensRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly securityAuditLog: SecurityAuditLogService,
    private readonly appUrl: AppUrlService,
  ) {}

  async execute(
    email: string,
    context: ForgotPasswordContext = {},
  ): Promise<void> {
    const account = await this.accountsRepository.findByEmail(email);

    // Recorded regardless of account existence so the "always 200" response
    // stays non-enumerable while abuse is still observable in the security trail.
    await this.securityAuditLog.record({
      event: 'password.reset.requested',
      severity: 'info',
      accountId: account?.id ?? null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    if (!account) return;

    await this.resetTokensRepository.invalidateAllByAccountId(account.id);

    const token = randomBytes(32).toString('hex');
    const tokenHash = await this.passwordHasher.hash(token);

    const passwordResetToken = PasswordResetToken.create({
      accountId: account.id,
      tokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 15),
    });

    await this.resetTokensRepository.create(passwordResetToken);

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
