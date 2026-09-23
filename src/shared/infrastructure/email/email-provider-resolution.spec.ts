import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { BrevoEmailSenderProvider } from './brevo-email-sender.provider';
import { ConsoleEmailSenderProvider } from './console-email-sender.provider';
import { resolveEmailSender } from './email.module';
import { SmtpEmailSenderProvider } from './smtp-email-sender.provider';

function envWith(values: Record<string, unknown>): EnvService {
  return {
    get: (key: string) => values[key],
  } as unknown as EnvService;
}

describe('resolveEmailSender', () => {
  beforeEach(() => {
    // The module logs its degradations; silence them without hiding failures.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('defaults to console', () => {
    expect(
      resolveEmailSender(envWith({ EMAIL_PROVIDER: 'console' })),
    ).toBeInstanceOf(ConsoleEmailSenderProvider);
  });

  it('uses Brevo when it has a key', () => {
    const sender = resolveEmailSender(
      envWith({
        EMAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'xkeysib-123',
        EMAIL_FROM: 'no-reply@empresa.com',
      }),
    );

    expect(sender).toBeInstanceOf(BrevoEmailSenderProvider);
  });

  it('degrades Brevo to console instead of failing the boot', () => {
    // Mail is optional: a missing credential must log and degrade, never throw.
    for (const key of [undefined, '', '   ']) {
      const sender = resolveEmailSender(
        envWith({ EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: key }),
      );

      expect(sender).toBeInstanceOf(ConsoleEmailSenderProvider);
    }
  });

  it('uses SMTP when host, user and pass are all present', () => {
    const sender = resolveEmailSender(
      envWith({
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.empresa.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_PORT: 587,
      }),
    );

    expect(sender).toBeInstanceOf(SmtpEmailSenderProvider);
  });

  it.each(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'])(
    'degrades SMTP to console when %s is missing',
    (missing) => {
      const values: Record<string, unknown> = {
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.empresa.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_PORT: 587,
      };
      delete values[missing];

      expect(resolveEmailSender(envWith(values))).toBeInstanceOf(
        ConsoleEmailSenderProvider,
      );
    },
  );

  it('treats a blank SMTP credential as missing', () => {
    const sender = resolveEmailSender(
      envWith({
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: '   ',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
        SMTP_PORT: 587,
      }),
    );

    expect(sender).toBeInstanceOf(ConsoleEmailSenderProvider);
  });
});
