import { Logger, Module } from '@nestjs/common';
import { ConsoleEmailSenderProvider } from 'src/shared/infrastructure/email/console-email-sender.provider';
import { SmtpEmailSenderProvider } from 'src/shared/infrastructure/email/smtp-email-sender.provider';
import { BrevoEmailSenderProvider } from 'src/shared/infrastructure/email/brevo-email-sender.provider';
import { SimpleEmailTemplateRendererProvider } from 'src/shared/infrastructure/email/simple-email-template-renderer.provider';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

const logger = new Logger('EmailModule');

/**
 * Picks the sender from `EMAIL_PROVIDER`, degrading to console when the chosen
 * provider is missing credentials — mail is optional, so a misconfiguration logs
 * loudly instead of failing the boot.
 *
 * Resolved in a `useFactory` rather than at module-definition time. The previous
 * `useClass: resolveEmailSender()` ran while the class was being loaded, before
 * Nest had a container, which is why every branch read `process.env` directly
 * and bypassed the validated config.
 */
export function resolveEmailSender(env: EnvService): EmailSenderPortInterface {
  const provider = env.get('EMAIL_PROVIDER');

  if (provider === 'brevo') {
    if (!env.get('BREVO_API_KEY')?.trim()) {
      logger.warn(
        'EMAIL_PROVIDER=brevo but BREVO_API_KEY is not set. Falling back to console.',
      );
      return new ConsoleEmailSenderProvider();
    }

    return new BrevoEmailSenderProvider(env);
  }

  if (provider === 'smtp') {
    const missing = (['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const).filter(
      (key) => !env.get(key)?.trim(),
    );

    if (missing.length > 0) {
      logger.warn(
        `EMAIL_PROVIDER=smtp but missing env vars: ${missing.join(', ')}. Falling back to console.`,
      );
      return new ConsoleEmailSenderProvider();
    }

    return new SmtpEmailSenderProvider(env);
  }

  return new ConsoleEmailSenderProvider();
}

@Module({
  providers: [
    {
      provide: EmailSenderPortInterface,
      inject: [EnvService],
      useFactory: resolveEmailSender,
    },
    {
      provide: EmailTemplateRendererPortInterface,
      useClass: SimpleEmailTemplateRendererProvider,
    },
  ],
  exports: [EmailSenderPortInterface, EmailTemplateRendererPortInterface],
})
export class EmailModule {}
