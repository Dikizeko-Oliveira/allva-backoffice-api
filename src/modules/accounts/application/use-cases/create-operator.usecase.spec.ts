import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PlatformRoleService } from '../services/platform-role.service';
import { CreateOperatorUseCase } from './create-operator.usecase';

function build(options: { actorRole?: string; existingEmail?: boolean } = {}) {
  const accounts: Record<string, { id: string; role?: string }> = {
    actor: { id: 'actor', role: options.actorRole ?? 'ALLVA_ADMIN' },
  };
  const saved: unknown[] = [];
  const accountsRepository = {
    findById: jest.fn(async (id: string) => accounts[id] ?? null),
    findByEmail: jest.fn(async () =>
      options.existingEmail ? { id: 'existing', role: 'USER' } : null,
    ),
    save: jest.fn(async (account: unknown) => {
      saved.push(account);
    }),
  };
  const passwordHasher = {
    hash: jest.fn(async (value: string) => `hash:${value}`),
  };
  const resetTokensRepository = {
    invalidateAllByAccountId: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(undefined),
  };
  const emailTemplates = {
    render: jest.fn().mockResolvedValue({
      subject: 'Defina sua senha',
      html: '<p>senha</p>',
      text: 'senha',
    }),
  };
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const record = jest.fn().mockResolvedValue(undefined);

  const useCase = new CreateOperatorUseCase(
    accountsRepository as never,
    passwordHasher as never,
    resetTokensRepository as never,
    emailSender as never,
    emailTemplates as never,
    { pathTo: (path: string) => `https://app.test/${path}` } as never,
    new PlatformRoleService(accountsRepository as never),
    { record } as never,
  );
  (useCase as unknown as { logger: { log: () => void } }).logger.log = () =>
    undefined;

  return {
    useCase,
    accountsRepository,
    resetTokensRepository,
    emailTemplates,
    emailSender,
    record,
    saved,
  };
}

describe('CreateOperatorUseCase', () => {
  it('exige users:manage_platform_role', async () => {
    const h = build({ actorRole: 'ALLVA_SUPPORT' });

    await expect(
      h.useCase.execute(
        {
          name: 'Operadora',
          email: 'operadora@allva.test',
          platformRole: 'ALLVA_SUPPORT',
        },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.accountsRepository.save).not.toHaveBeenCalled();
  });

  it('cria operador e envia link para definir senha', async () => {
    const h = build();

    const result = await h.useCase.execute(
      {
        name: 'Operadora',
        email: 'operadora@allva.test',
        platformRole: 'ALLVA_SUPPORT',
      },
      'actor',
    );

    expect(result).toMatchObject({
      name: 'Operadora',
      email: 'operadora@allva.test',
      platformRole: 'ALLVA_SUPPORT',
      status: 'ACTIVE',
    });
    expect(result.platformPermissions).toContain('support:manage');
    expect(h.accountsRepository.save).toHaveBeenCalled();
    expect(h.resetTokensRepository.create).toHaveBeenCalled();
    expect(h.emailTemplates.render).toHaveBeenCalledWith(
      'forgot-password',
      expect.objectContaining({
        name: 'Operadora',
        resetUrl: expect.stringContaining('/auth/reset-password?token='),
      }),
    );
    expect(h.emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'operadora@allva.test' }),
    );
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'account.created',
        actorId: 'actor',
        metadata: expect.objectContaining({
          method: 'platform_operator_invite',
          platformRole: 'ALLVA_SUPPORT',
        }),
      }),
    );
  });

  it('recusa e-mail já cadastrado', async () => {
    const h = build({ existingEmail: true });

    await expect(
      h.useCase.execute(
        {
          name: 'Operadora',
          email: 'operadora@allva.test',
          platformRole: 'ALLVA_SUPPORT',
        },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.accountsRepository.save).not.toHaveBeenCalled();
  });
});
