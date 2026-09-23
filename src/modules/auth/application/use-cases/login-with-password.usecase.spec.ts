import { Account } from 'src/modules/accounts/domain/entities';
import { LoginWithPasswordUseCase } from './login-with-password.usecase';

function account(emailVerified: boolean) {
  return Account.create({
    name: 'Ana',
    email: 'ana@empresa.com',
    passwordHash: 'stored-hash',
    emailVerified,
  });
}

function buildHarness(options: {
  account?: Account | null;
  passwordMatches?: boolean;
}) {
  const accountsRepository = {
    findByEmail: jest
      .fn()
      .mockResolvedValue(
        options.account === undefined ? null : options.account,
      ),
  };
  const passwordHasher = {
    compare: jest.fn().mockResolvedValue(options.passwordMatches ?? true),
  };
  const issueAuthSessionUseCase = {
    execute: jest.fn().mockResolvedValue({ accessToken: 'jwt' }),
  };
  const bruteForce = {
    assertNotLocked: jest.fn().mockResolvedValue(undefined),
    registerFailure: jest.fn().mockResolvedValue(undefined),
  };
  const suspiciousActivity = {
    evaluate: jest.fn().mockResolvedValue(undefined),
  };

  const useCase = new LoginWithPasswordUseCase(
    accountsRepository as any,
    passwordHasher as any,
    issueAuthSessionUseCase as any,
    bruteForce as any,
    suspiciousActivity as any,
  );

  return { useCase, issueAuthSessionUseCase, bruteForce, suspiciousActivity };
}

const credentials = {
  email: 'ana@empresa.com',
  password: 'senha-correta',
} as any;

describe('LoginWithPasswordUseCase — email verification gate (A-4)', () => {
  it('refuses to issue a session for an unverified account', async () => {
    const h = buildHarness({ account: account(false) });

    await expect(h.useCase.execute(credentials)).rejects.toMatchObject({
      response: { code: 'EMAIL_NOT_VERIFIED' },
    });
    expect(h.issueAuthSessionUseCase.execute).not.toHaveBeenCalled();
  });

  it('issues a session once the account is verified', async () => {
    const h = buildHarness({ account: account(true) });

    await expect(h.useCase.execute(credentials)).resolves.toEqual({
      accessToken: 'jwt',
    });
    expect(h.issueAuthSessionUseCase.execute).toHaveBeenCalledTimes(1);
  });

  it('still rejects wrong credentials generically before the verification check', async () => {
    const h = buildHarness({
      account: account(false),
      passwordMatches: false,
    });

    await expect(h.useCase.execute(credentials)).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS' },
    });
    expect(h.bruteForce.registerFailure).toHaveBeenCalled();
  });
});
