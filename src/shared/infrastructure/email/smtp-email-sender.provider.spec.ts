import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SmtpEmailSenderProvider } from './smtp-email-sender.provider';

const createTransport = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => createTransport(...args),
}));

const BASE = {
  SMTP_HOST: 'smtp.empresa.com',
  SMTP_PORT: 587,
  SMTP_USER: 'user',
  SMTP_PASS: 'pass',
};

function buildProvider(values: Record<string, unknown>) {
  const sendMail = jest.fn().mockResolvedValue(undefined);
  createTransport.mockReturnValue({ sendMail });

  const env = { get: (key: string) => values[key] } as unknown as EnvService;
  const provider = new SmtpEmailSenderProvider(env);

  jest
    .spyOn((provider as any).logger, 'log')
    .mockImplementation(() => undefined);

  return {
    provider,
    sendMail,
    transportOptions: createTransport.mock.calls[0][0],
  };
}

/** The resolved sender is only observable through an actual send, which is also
 *  the value that reaches the SMTP server. */
async function resolvedFrom(values: Record<string, unknown>): Promise<string> {
  const { provider, sendMail } = buildProvider(values);

  await provider.send({ to: 'user@example.com', subject: 'S', html: '<p/>' });

  return (sendMail.mock.calls[0][0] as { from: string }).from;
}

describe('SmtpEmailSenderProvider', () => {
  afterEach(() => jest.clearAllMocks());

  describe('sender address', () => {
    it('prefers SMTP_FROM', async () => {
      await expect(
        resolvedFrom({
          ...BASE,
          SMTP_FROM: 'smtp@empresa.com',
          EMAIL_FROM: 'geral@empresa.com',
        }),
      ).resolves.toBe('smtp@empresa.com');
    });

    /**
     * The bug this closes. `SMTP_FROM` used to jump straight to a hardcoded
     * `noreply@allva.app`, so a deployment that configured `EMAIL_FROM` and
     * switched `EMAIL_PROVIDER` to smtp silently sent from a different address
     * than the one it had set — on a custom domain that is the difference
     * between delivery and a DMARC rejection.
     */
    it('falls back to EMAIL_FROM before the hardcoded address', async () => {
      await expect(
        resolvedFrom({ ...BASE, EMAIL_FROM: 'geral@empresa.com' }),
      ).resolves.toBe('geral@empresa.com');
    });

    it('uses the hardcoded address only when neither is set', async () => {
      await expect(resolvedFrom(BASE)).resolves.toBe('noreply@allva.app');
    });

    it('treats a blank SMTP_FROM as absent', async () => {
      await expect(
        resolvedFrom({
          ...BASE,
          SMTP_FROM: '   ',
          EMAIL_FROM: 'geral@empresa.com',
        }),
      ).resolves.toBe('geral@empresa.com');
    });

    it('lets an explicit per-message sender win', async () => {
      const { provider, sendMail } = buildProvider({
        ...BASE,
        EMAIL_FROM: 'geral@empresa.com',
      });

      await provider.send({
        to: 'user@example.com',
        subject: 'S',
        html: '<p/>',
        from: 'suporte@empresa.com',
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'suporte@empresa.com' }),
      );
    });
  });

  describe('message fields', () => {
    /**
     * Antes desta correção o provider SMTP só repassava `to`/`subject`/`html`
     * ao nodemailer: `message.text` e `message.replyTo` chegavam à porta e
     * eram descartados em silêncio — o único provider (Brevo) que os
     * repassava não é o caminho de produção mais comum fora dele.
     */
    it('forwards the plain-text body when present', async () => {
      const { provider, sendMail } = buildProvider(BASE);

      await provider.send({
        to: 'user@example.com',
        subject: 'S',
        html: '<p/>',
        text: 'Plain text body',
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Plain text body' }),
      );
    });

    it('omits the text field entirely when the message has none', async () => {
      const { provider, sendMail } = buildProvider(BASE);

      await provider.send({
        to: 'user@example.com',
        subject: 'S',
        html: '<p/>',
      });

      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('text');
    });

    it('forwards replyTo when present', async () => {
      const { provider, sendMail } = buildProvider(BASE);

      await provider.send({
        to: 'user@example.com',
        subject: 'S',
        html: '<p/>',
        replyTo: 'suporte@empresa.com',
      });

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ replyTo: 'suporte@empresa.com' }),
      );
    });
  });

  describe('transport', () => {
    it('uses implicit TLS only on 465', () => {
      expect(
        buildProvider({ ...BASE, SMTP_PORT: 465 }).transportOptions,
      ).toMatchObject({ port: 465, secure: true });

      jest.clearAllMocks();

      expect(
        buildProvider({ ...BASE, SMTP_PORT: 587 }).transportOptions,
      ).toMatchObject({ port: 587, secure: false });
    });

    it('passes host and credentials through', () => {
      expect(buildProvider(BASE).transportOptions).toMatchObject({
        host: 'smtp.empresa.com',
        auth: { user: 'user', pass: 'pass' },
      });
    });
  });
});
