import { Injectable, Logger } from '@nestjs/common';
import {
  EmailMessage,
  EmailSenderPortInterface,
} from 'src/shared/application/ports/email-sender.port';

@Injectable()
export class ConsoleEmailSenderProvider implements EmailSenderPortInterface {
  private readonly logger = new Logger(ConsoleEmailSenderProvider.name);

  // Not `async`: there is nothing to await, and the port is what requires the
  // Promise. Declaring it async only to satisfy the signature is what tripped
  // `require-await`.
  send(message: EmailMessage): Promise<void> {
    this.logger.log(`Sending email to ${message.to}`);
    this.logger.log(`Subject: ${message.subject}`);
    if (message.text !== undefined) {
      this.logger.log(`Text: ${message.text}`);
    }
    this.logger.log(`Body: ${message.html}`);

    return Promise.resolve();
  }
}
