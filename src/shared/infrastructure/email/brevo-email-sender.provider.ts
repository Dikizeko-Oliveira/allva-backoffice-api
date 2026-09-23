import { Injectable, Logger } from '@nestjs/common';
import { BrevoClient } from '@getbrevo/brevo';
import {
  EmailMessage,
  EmailSenderPortInterface,
} from 'src/shared/application/ports/email-sender.port';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

const FALLBACK_FROM = 'noreply@allva.app';
const FALLBACK_FROM_NAME = 'Allva';

@Injectable()
export class BrevoEmailSenderProvider implements EmailSenderPortInterface {
  private readonly logger = new Logger(BrevoEmailSenderProvider.name);
  private readonly client: BrevoClient;
  private readonly fromEmail: string;
  private readonly fromName: string;

  // Read through EnvService so these are the validated values; the module only
  // constructs this provider once BREVO_API_KEY is confirmed present.
  constructor(private readonly env: EnvService) {
    this.fromEmail = this.env.get('EMAIL_FROM')?.trim() || FALLBACK_FROM;
    this.fromName =
      this.env.get('EMAIL_FROM_NAME')?.trim() || FALLBACK_FROM_NAME;
    this.client = new BrevoClient({
      apiKey: this.env.get('BREVO_API_KEY') ?? '',
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.client.transactionalEmails.sendTransacEmail({
        sender: {
          email: message.from ?? this.fromEmail,
          name: this.fromName,
        },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        ...(message.text !== undefined && { textContent: message.text }),
        ...(message.replyTo !== undefined && {
          replyTo: { email: message.replyTo },
        }),
      });

      this.logger.log(
        `Email sent via Brevo to ${message.to} — subject: "${message.subject}"`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Brevo failed to send email to ${message.to} — subject: "${message.subject}" — ${detail}`,
      );
      throw error;
    }
  }
}
