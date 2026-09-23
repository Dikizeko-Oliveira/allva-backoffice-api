import { Account } from 'src/modules/accounts/domain/entities';
import { AccountOnboardingService } from './account-onboarding.service';

function newAccount() {
  return Account.create({
    name: 'Ana',
    email: 'ana@empresa.com',
    passwordHash: 'hash',
  });
}

function buildHarness(existingPreference: unknown = null) {
  const preferencesRepository = {
    findByAccountId: jest.fn().mockResolvedValue(existingPreference),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const emailTemplates = {
    render: jest.fn().mockResolvedValue({ subject: 'S', html: '<p/>' }),
  };

  const appUrl = {
    baseUrl: 'https://app.test',
    pathTo: (path: string) => `https://app.test/${path.replace(/^\/+/, '')}`,
  };

  const organizationProvisioning = {
    ensureForAccount: jest
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', created: true }),
  };

  const service = new AccountOnboardingService(
    preferencesRepository as any,
    emailSender as any,
    emailTemplates as any,
    appUrl as any,
    organizationProvisioning as any,
  );

  return {
    service,
    preferencesRepository,
    emailSender,
    organizationProvisioning,
  };
}

describe('AccountOnboardingService (M-7)', () => {
  it('creates a Preference row for a brand-new account', async () => {
    const h = buildHarness();

    await h.service.execute(newAccount());

    expect(h.preferencesRepository.save).toHaveBeenCalledTimes(1);
    const [saved] = h.preferencesRepository.save.mock.calls[0];
    expect(saved.notificationByEmail).toBe(true);
  });

  it('is idempotent when a Preference already exists', async () => {
    const h = buildHarness({ id: 'pref-1' });

    await h.service.execute(newAccount());

    expect(h.preferencesRepository.save).not.toHaveBeenCalled();
  });

  it('sends the welcome email only when asked', async () => {
    const h = buildHarness();

    await h.service.execute(newAccount(), { sendWelcomeEmail: false });
    expect(h.emailSender.send).not.toHaveBeenCalled();

    await h.service.execute(newAccount(), { sendWelcomeEmail: true });
    expect(h.emailSender.send).toHaveBeenCalledTimes(1);
  });

  it('never breaks signup when the preference write fails', async () => {
    const h = buildHarness();
    h.preferencesRepository.save.mockRejectedValue(new Error('db down'));

    await expect(h.service.execute(newAccount())).resolves.toBeUndefined();
  });

  it('never breaks signup when the welcome email fails', async () => {
    const h = buildHarness();
    h.emailSender.send.mockRejectedValue(new Error('smtp down'));

    await expect(
      h.service.execute(newAccount(), { sendWelcomeEmail: true }),
    ).resolves.toBeUndefined();
  });

  it('provisiona a organização que o resto do produto pressupõe', async () => {
    // O cadastro era account-first num produto organization-first: sem esta
    // chamada a conta nasce sem organização, e dashboard, integrações e a tela
    // de organização não têm o que responder.
    const h = buildHarness();

    await h.service.execute(newAccount());

    expect(h.organizationProvisioning.ensureForAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountName: 'Ana',
        accountEmail: 'ana@empresa.com',
        source: 'signup',
      }),
    );
  });

  it('never breaks signup when the organization write fails', async () => {
    /**
     * A conta já foi gravada quando este serviço roda. Propagar o erro trocaria
     * "organização faltando" — que `CreateIntegrationUseCase` e
     * `provision:organizations` curam — por "conta existente que não consegue
     * cadastrar de novo", que só o suporte desfaz.
     */
    const h = buildHarness();
    h.organizationProvisioning.ensureForAccount.mockRejectedValue(
      new Error('db down'),
    );

    await expect(h.service.execute(newAccount())).resolves.toBeUndefined();
  });
});
