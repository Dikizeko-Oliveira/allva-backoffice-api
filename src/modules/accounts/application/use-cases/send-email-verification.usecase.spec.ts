import { Account } from 'src/modules/accounts/domain/entities';
import { SendEmailVerificationUseCase } from './send-email-verification.usecase';

function account(overrides: { emailVerified?: boolean } = {}) {
  return Account.create({
    name: 'Ana',
    email: 'ana@empresa.com',
    passwordHash: 'hash',
    emailVerified: overrides.emailVerified ?? false,
  });
}

function buildHarness(found: Account | null = null) {
  const accountsRepository = {
    findByEmail: jest.fn().mockResolvedValue(found),
  };
  const tokensRepository = {
    save: jest.fn().mockResolvedValue(undefined),
    invalidateAllByAccountId: jest.fn().mockResolvedValue(undefined),
  };
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const emailTemplates = {
    render: jest.fn().mockResolvedValue({ subject: 'S', html: '<p/>' }),
  };

  const useCase = new SendEmailVerificationUseCase(
    accountsRepository as any,
    tokensRepository as any,
    emailSender as any,
    emailTemplates as any,
  );

  return {
    useCase,
    accountsRepository,
    tokensRepository,
    emailSender,
    emailTemplates,
  };
}

describe('SendEmailVerificationUseCase', () => {
  it('emails a 6-digit code and stores only its hash', async () => {
    const target = account();
    const h = buildHarness(target);

    await h.useCase.executeForAccount(target);

    expect(h.emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: target.email }),
    );

    const [, props] = h.emailTemplates.render.mock.calls[0];
    expect(props.code).toMatch(/^\d{6}$/);

    // O código cru nunca chega ao banco — só o hash escopado pela conta.
    const [saved] = h.tokensRepository.save.mock.calls[0];
    expect(saved.tokenHash).toHaveLength(64);
    expect(saved.tokenHash).not.toContain(props.code);
  });

  it('keeps leading zeros so the search space stays at 10^6', async () => {
    // Sem `padStart`, um em cada dez códigos sairia com cinco dígitos.
    const target = account();
    const h = buildHarness(target);

    for (let i = 0; i < 50; i += 1) {
      await h.useCase.executeForAccount(target);
    }

    for (const [, props] of h.emailTemplates.render.mock.calls) {
      expect(props.code).toHaveLength(6);
    }
  });

  it('invalidates previous codes before issuing a new one', async () => {
    const target = account();
    const h = buildHarness(target);

    await h.useCase.executeForAccount(target);

    expect(h.tokensRepository.invalidateAllByAccountId).toHaveBeenCalledWith(
      target.id,
    );
  });

  it('does nothing for an account that is already verified', async () => {
    const target = account({ emailVerified: true });
    const h = buildHarness(target);

    await h.useCase.executeForAccount(target);

    expect(h.tokensRepository.save).not.toHaveBeenCalled();
    expect(h.emailSender.send).not.toHaveBeenCalled();
  });

  it('resolves silently for an unknown email (no account enumeration)', async () => {
    const h = buildHarness(null);

    await expect(
      h.useCase.execute('desconhecido@empresa.com'),
    ).resolves.toBeUndefined();
    expect(h.emailSender.send).not.toHaveBeenCalled();
  });

  it('resolves silently when resending to an already-verified account', async () => {
    const h = buildHarness(account({ emailVerified: true }));

    await expect(h.useCase.execute('ana@empresa.com')).resolves.toBeUndefined();
    expect(h.emailSender.send).not.toHaveBeenCalled();
  });
});
