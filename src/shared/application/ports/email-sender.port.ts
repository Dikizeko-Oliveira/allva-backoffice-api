export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  from?: string;
  text?: string;
  replyTo?: string;
};

export abstract class EmailSenderPortInterface {
  abstract send(message: EmailMessage): Promise<void>;
}
