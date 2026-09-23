import {
  Account,
  EmailVerificationToken,
} from 'src/modules/accounts/domain/entities';
import { VerifyEmailUseCase } from './verify-email.usecase';

const CODE = '048213';
const WRONG_CODE = '111111';

function unverifiedAccount() {
  return Account.create({
    name: 'Ana',
    email: 'ana@empresa.com',
    passwordHash: 'hash',
  });
}

function buildHarness(options: {
  token?: EmailVerificationToken | null;
  account?: Account | null;
}) {
  const account = options.account ?? unverifiedAccount();

  const accountsRepository = {
    findByEmail: jest
      .fn()
      .mockResolvedValue(options.account === null ? null : account),
    markEmailVerified: jest.fn().mockResolvedValue(undefined),
  };
  const tokensRepository = {
    findPendingByAccountId: jest
      .fn()
      .mockResolvedValue(options.token === undefined ? null : options.token),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const onboarding = { execute: jest.fn().mockResolvedValue(undefined) };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const bruteForce = {
    assertNotLocked: jest.fn().mockResolvedValue(undefined),
    registerFailure: jest.fn().mockResolvedValue(undefined),
  };

  const useCase = new VerifyEmailUseCase(
    accountsRepository as any,
    tokensRepository as any,
    onboarding as any,
    auditLog as any,
    bruteForce as any,
  );

  return {
    useCase,
    accountsRepository,
    tokensRepository,
    onboarding,
    auditLog,
    bruteForce,
    account,
    verify: (code = CODE) =>
      useCase.execute({ email: 'ana@empresa.com', code }),
  };
}

function pendingCode(accountId: string, code = CODE) {
  return EmailVerificationToken.create({
    accountId,
    tokenHash: EmailVerificationToken.hashCode(accountId, code),
  });
}

describe('VerifyEmailUseCase', () => {
  it('verifies the account and consumes the code', async () => {
    const account = unverifiedAccount();
    const h = buildHarness({ token: pendingCode(account.id), account });

    await expect(h.verify()).resolves.toMatchObject({
      accountId: account.id,
      emailVerified: true,
    });

    expect(h.account.emailVerified).toBe(true);
    expect(h.accountsRepository.markEmailVerified).toHaveBeenCalledWith(
      h.account,
    );
    expect(h.tokensRepository.update).toHaveBeenCalledTimes(1);
  });

  it('returns the account so the controller can issue the session', async () => {
    const account = unverifiedAccount();
    const h = buildHarness({ token: pendingCode(account.id), account });

    // É o que mantém o cadastro em pé: sem a conta aqui, o /login recusaria a
    // sessão com 403 e o fluxo pararia entre a criação e o pagamento.
    await expect(h.verify()).resolves.toMatchObject({ account });
  });

  it('sends the welcome email that signup withheld', async () => {
    const account = unverifiedAccount();
    const h = buildHarness({ token: pendingCode(account.id), account });

    await h.verify();

    expect(h.onboarding.execute).toHaveBeenCalledWith(account, {
      sendWelcomeEmail: true,
    });
  });

  it('counts a wrong code against the attempt cap', async () => {
    const account = unverifiedAccount();
    const token = pendingCode(account.id);
    const h = buildHarness({ token, account });

    await expect(h.verify(WRONG_CODE)).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });

    expect(token.attempts).toBe(1);
    // Gravado, e não só contado em memória — o teto tem de sobreviver ao request.
    expect(h.tokensRepository.update).toHaveBeenCalledTimes(1);
    expect(h.bruteForce.registerFailure).toHaveBeenCalledTimes(1);
    expect(h.accountsRepository.markEmailVerified).not.toHaveBeenCalled();
  });

  it('kills the code once the attempt cap is spent', async () => {
    const account = unverifiedAccount();
    const token = pendingCode(account.id);
    for (let i = 0; i < EmailVerificationToken.maxAttempts; i += 1) {
      token.registerFailedAttempt();
    }
    const h = buildHarness({ token, account });

    // Mesmo com o código certo: cinco erros queimam a emissão.
    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
    expect(h.accountsRepository.markEmailVerified).not.toHaveBeenCalled();
  });

  it('rejects a code that belongs to another account', async () => {
    const account = unverifiedAccount();
    // O hash é escopado pela conta: os mesmos seis dígitos de outra conta não
    // podem confirmar esta.
    const h = buildHarness({ token: pendingCode('outra-conta'), account });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
  });

  it('rejects when there is no pending code', async () => {
    const h = buildHarness({ token: null });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
    expect(h.accountsRepository.markEmailVerified).not.toHaveBeenCalled();
  });

  it('rejects an already-used code (replay)', async () => {
    const account = unverifiedAccount();
    const token = pendingCode(account.id);
    token.markAsUsed();
    const h = buildHarness({ token, account });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
  });

  it('rejects an expired code', async () => {
    const account = unverifiedAccount();
    const token = EmailVerificationToken.create({
      accountId: account.id,
      tokenHash: EmailVerificationToken.hashCode(account.id, CODE),
      expiresAt: new Date(Date.now() - 1000),
    });
    const h = buildHarness({ token, account });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
  });

  it('gives an unknown email the same answer as a wrong code', async () => {
    const h = buildHarness({ token: null, account: null });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
  });

  it('gives an already-verified account the same answer', async () => {
    const account = unverifiedAccount();
    account.markEmailVerified();
    const h = buildHarness({ token: pendingCode(account.id), account });

    await expect(h.verify()).rejects.toMatchObject({
      response: { code: 'VERIFICATION_CODE_INVALID' },
    });
  });

  it('refuses to even look while the caller is locked out', async () => {
    const account = unverifiedAccount();
    const h = buildHarness({ token: pendingCode(account.id), account });
    h.bruteForce.assertNotLocked.mockRejectedValueOnce(new Error('locked'));

    await expect(h.verify()).rejects.toThrow('locked');
    expect(h.accountsRepository.findByEmail).not.toHaveBeenCalled();
  });
});
