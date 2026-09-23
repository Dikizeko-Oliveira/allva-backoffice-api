import { Account } from 'src/modules/accounts/domain/entities';
import { IssueAuthSessionUseCase } from './issue-auth-session.usecase';

function account(role: 'USER' | 'ALLVA_SUPPORT') {
  return Account.create({
    name: 'Ana',
    email: 'ana@empresa.com',
    passwordHash: 'stored-hash',
    emailVerified: true,
    role,
  });
}

function buildHarness() {
  const sessionsRepository = { save: jest.fn().mockResolvedValue(undefined) };
  const useCase = new IssueAuthSessionUseCase(
    { hash: jest.fn().mockResolvedValue('hash') } as never,
    { sign: jest.fn().mockResolvedValue('jwt') } as never,
    sessionsRepository as never,
  );

  return { useCase, sessionsRepository };
}

describe('IssueAuthSessionUseCase — audiência do login', () => {
  it.each([
    ['app', 'ALLVA_SUPPORT', 'PLATFORM_ACCOUNT_NOT_CUSTOMER'],
    ['backoffice', 'USER', 'BACKOFFICE_ACCESS_DENIED'],
  ] as const)(
    'audience=%s recusa conta %s com %s, sem criar sessão',
    async (audience, role, code) => {
      const h = buildHarness();

      await expect(
        h.useCase.execute({ account: account(role), audience }),
      ).rejects.toMatchObject({ response: { code } });
      expect(h.sessionsRepository.save).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['app', 'USER'],
    ['backoffice', 'ALLVA_SUPPORT'],
  ] as const)('audience=%s aceita conta %s', async (audience, role) => {
    const h = buildHarness();

    await expect(
      h.useCase.execute({ account: account(role), audience }),
    ).resolves.toMatchObject({ accessToken: 'jwt' });
  });

  it('sem audiência não checa nada (compatibilidade com clientes antigos)', async () => {
    const h = buildHarness();

    await expect(
      h.useCase.execute({ account: account('ALLVA_SUPPORT') }),
    ).resolves.toMatchObject({ accessToken: 'jwt' });
  });
});
