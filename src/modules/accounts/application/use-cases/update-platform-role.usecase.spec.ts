import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PlatformRoleService } from '../services/platform-role.service';
import { UpdatePlatformRoleUseCase } from './update-platform-role.usecase';

type Result =
  | { outcome: 'UPDATED'; previousRole: string }
  | { outcome: 'UNCHANGED' }
  | { outcome: 'LAST_ADMIN' };

function build(options: {
  actorRole?: string;
  targetRole?: string | null;
  result?: Result;
}) {
  const accounts: Record<
    string,
    { id: string; name: string; email: string; role?: string }
  > = {
    actor: {
      id: 'actor',
      name: 'Admin',
      email: 'a@allva',
      role: options.actorRole ?? 'ALLVA_ADMIN',
    },
  };

  if (options.targetRole !== null) {
    accounts.target = {
      id: 'target',
      name: 'Camila',
      email: 'c@allva',
      role: options.targetRole ?? 'ALLVA_OPERATOR',
    };
  }

  const changePlatformRole = jest
    .fn()
    .mockResolvedValue(
      options.result ?? { outcome: 'UPDATED', previousRole: 'ALLVA_OPERATOR' },
    );

  const repository = {
    findById: jest.fn(async (id: string) => accounts[id] ?? null),
    changePlatformRole,
  };

  const record = jest.fn().mockResolvedValue(undefined);

  const useCase = new UpdatePlatformRoleUseCase(
    repository as never,
    new PlatformRoleService(repository as never),
    { record } as never,
  );
  (useCase as unknown as { logger: { log: () => void } }).logger.log = () =>
    undefined;

  return { useCase, changePlatformRole, record };
}

describe('UpdatePlatformRoleUseCase', () => {
  /**
   * A única permissão que se auto-multiplica. Nenhum papel de área a tem —
   * nem operações, que até B13 fazia tudo.
   */
  it.each([
    'ALLVA_OPERATOR',
    'ALLVA_SUPPORT',
    'ALLVA_FINANCE',
    'ALLVA_SALES',
    'USER',
  ])('%s não concede papel', async (actorRole) => {
    const h = build({ actorRole });

    await expect(
      h.useCase.execute('target', { platformRole: 'ALLVA_ADMIN' }, 'actor'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.changePlatformRole).not.toHaveBeenCalled();
  });

  it('administração troca a área de um operador, e a trilha registra de → para', async () => {
    const h = build({});

    const result = await h.useCase.execute(
      'target',
      { platformRole: 'ALLVA_FINANCE' },
      'actor',
    );

    expect(h.changePlatformRole).toHaveBeenCalledWith(
      'target',
      'ALLVA_FINANCE',
    );
    expect(result.platformRole).toBe('ALLVA_FINANCE');
    expect(result.platformPermissions).toContain('billing:manage');
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'account.platform_role.updated',
        entityId: 'target',
        actorId: 'actor',
        organizationId: null,
        metadata: { from: 'ALLVA_OPERATOR', to: 'ALLVA_FINANCE' },
      }),
    );
  });

  /**
   * Transformar cliente em operador é o convite (B19). Aceitar aqui daria
   * acesso de plataforma a quem nunca aceitou ser operador, com a senha que
   * ele usa no produto.
   */
  it('recusa promover conta de cliente', async () => {
    const h = build({ targetRole: 'USER' });

    await expect(
      h.useCase.execute('target', { platformRole: 'ALLVA_SUPPORT' }, 'actor'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(h.changePlatformRole).not.toHaveBeenCalled();
  });

  it('recusa rebaixar a última administração, e não audita nada', async () => {
    const h = build({
      targetRole: 'ALLVA_ADMIN',
      result: { outcome: 'LAST_ADMIN' },
    });

    await expect(
      h.useCase.execute('target', { platformRole: 'ALLVA_SUPPORT' }, 'actor'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.record).not.toHaveBeenCalled();
  });

  it('repetir o papel atual não grava trilha — uma linha que não descreve nada', async () => {
    const h = build({ result: { outcome: 'UNCHANGED' } });

    await h.useCase.execute(
      'target',
      { platformRole: 'ALLVA_OPERATOR' },
      'actor',
    );

    expect(h.record).not.toHaveBeenCalled();
  });

  it('alvo inexistente é 404', async () => {
    const h = build({ targetRole: null });

    await expect(
      h.useCase.execute('target', { platformRole: 'ALLVA_SUPPORT' }, 'actor'),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
  });
});
