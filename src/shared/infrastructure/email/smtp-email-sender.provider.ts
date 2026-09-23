import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import {
  EmailMessage,
  EmailSenderPortInterface,
} from 'src/shared/application/ports/email-sender.port';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/** Last-resort sender, used only when neither SMTP_FROM nor EMAIL_FROM is set. */
const FALLBACK_FROM = 'noreply@allva.app';

/** Implicit TLS port. Every other port uses STARTTLS, which nodemailer upgrades
 *  to on its own when `secure` is false. */
const IMPLICIT_TLS_PORT = 465;

@Injectable()
export class SmtpEmailSenderProvider implements EmailSenderPortInterface {
  private readonly logger = new Logger(SmtpEmailSenderProvider.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly env: EnvService) {
    const port = this.env.get('SMTP_PORT');

    /**
     * `SMTP_FROM` now falls back to `EMAIL_FROM` before the hardcoded address.
     * It used to jump straight to the constant, so a deployment that set
     * `EMAIL_FROM` and switched `EMAIL_PROVIDER` to smtp silently sent from a
     * different address than the one it had configured — and on a custom domain
     * that is the difference between delivery and a DMARC rejection.
     */
    this.from =
      this.env.get('SMTP_FROM')?.trim() ||
      this.env.get('EMAIL_FROM')?.trim() ||
      FALLBACK_FROM;

    this.transporter = nodemailer.createTransport({
      host: this.env.get('SMTP_HOST'),
      port,
      secure: port === IMPLICIT_TLS_PORT,
      auth: {
        user: this.env.get('SMTP_USER'),
        pass: this.env.get('SMTP_PASS'),
      },
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: message.from ?? this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      ...(message.text !== undefined && { text: message.text }),
      ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
    });

    this.logger.log(
      `Email sent to ${message.to} — subject: "${message.subject}"`,
    );
  }
}
