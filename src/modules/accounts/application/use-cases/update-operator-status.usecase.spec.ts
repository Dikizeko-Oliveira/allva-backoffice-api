import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PlatformRoleService } from '../services/platform-role.service';
import { UpdateOperatorStatusUseCase } from './update-operator-status.usecase';

type Result =
  | { outcome: 'UPDATED'; previousStatus: 'ACTIVE' | 'DISABLED' }
  | { outcome: 'UNCHANGED' }
  | { outcome: 'LAST_ADMIN' };

function build(options: {
  actorRole?: string;
  targetRole?: string | null;
  result?: Result;
}) {
  const accounts: Record<string, { id: string; role?: string }> = {
    actor: { id: 'actor', role: options.actorRole ?? 'ALLVA_ADMIN' },
  };

  if (options.targetRole !== null) {
    accounts.target = {
      id: 'target',
      role: options.targetRole ?? 'ALLVA_SUPPORT',
    };
  }

  const changePlatformStatus = jest
    .fn()
    .mockResolvedValue(
      options.result ?? { outcome: 'UPDATED', previousStatus: 'ACTIVE' },
    );

  const repository = {
    findById: jest.fn(async (id: string) => accounts[id] ?? null),
    changePlatformStatus,
  };
  const record = jest.fn().mockResolvedValue(undefined);

  const useCase = new UpdateOperatorStatusUseCase(
    repository as never,
    new PlatformRoleService(repository as never),
    { record } as never,
  );
  (useCase as unknown as { logger: { log: () => void } }).logger.log = () =>
    undefined;

  return { useCase, changePlatformStatus, record };
}

describe('UpdateOperatorStatusUseCase', () => {
  it('exige users:manage', async () => {
    const h = build({ actorRole: 'ALLVA_SUPPORT' });

    await expect(
      h.useCase.execute(
        'target',
        { status: 'DISABLED', reason: 'fora do time' },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.changePlatformStatus).not.toHaveBeenCalled();
  });

  it('suspende operador e grava auditoria com motivo', async () => {
    const h = build({});

    const result = await h.useCase.execute(
      'target',
      { status: 'DISABLED', reason: 'desligamento' },
      'actor',
    );

    expect(result).toEqual({ id: 'target', status: 'DISABLED' });
    expect(h.changePlatformStatus).toHaveBeenCalledWith(
      'target',
      'DISABLED',
      'actor',
      'desligamento',
    );
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'account.platform_status.updated',
        entityId: 'target',
        actorId: 'actor',
        metadata: {
          from: 'ACTIVE',
          to: 'DISABLED',
          reason: 'desligamento',
        },
      }),
    );
  });

  it('recusa conta que não é de plataforma', async () => {
    const h = build({ targetRole: 'USER' });

    await expect(
      h.useCase.execute(
        'target',
        { status: 'DISABLED', reason: 'fora do time' },
        'actor',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(h.changePlatformStatus).not.toHaveBeenCalled();
  });

  it('recusa suspender a última administração ativa', async () => {
    const h = build({
      targetRole: 'ALLVA_ADMIN',
      result: { outcome: 'LAST_ADMIN' },
    });

    await expect(
      h.useCase.execute(
        'target',
        { status: 'DISABLED', reason: 'fora do time' },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.record).not.toHaveBeenCalled();
  });
});
