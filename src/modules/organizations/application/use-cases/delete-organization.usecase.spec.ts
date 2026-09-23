import { ForbiddenException } from '@nestjs/common';
import { DeleteOrganizationUseCase } from './delete-organization.usecase';

/**
 * A exclusão avisa quem guarda credencial — e só depois de gravada.
 *
 * O aviso é o que faz os tokens das plataformas saírem junto com a
 * organização. A ordem importa porque revogação não tem volta: um aviso antes
 * do commit, numa transação que se desfizesse, deixaria a organização de pé e
 * sem acesso às próprias contas.
 */

const OWNER = {
  organizationId: 'org-1',
  accountId: 'acc-1',
  membershipId: 'm-1',
  role: 'OWNER' as const,
};

function harness(
  options: { transactionFails?: boolean; ownerId?: string } = {},
) {
  const calls: string[] = [];

  const tx = {
    organization: {
      update: jest.fn(async () => {
        calls.push('soft-delete');
      }),
    },
    organizationUser: { updateMany: jest.fn(async () => undefined) },
    organizationInvitation: { updateMany: jest.fn(async () => undefined) },
    auditLog: { create: jest.fn(async () => undefined) },
  };

  const prisma = {
    organization: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'org-1',
        ownerId: options.ownerId ?? 'acc-1',
        name: 'Acme',
      }),
    },
    $transaction: jest.fn(
      async (work: (client: typeof tx) => Promise<void>) => {
        if (options.transactionFails) throw new Error('deadlock');
        await work(tx);
        calls.push('commit');
      },
    ),
  };

  const events = {
    emitFrom: jest.fn((_ctx: unknown, name: string) => {
      calls.push(`evento:${name}`);
      return { eventId: 'evt-1' };
    }),
  };

  const requestContext = {
    getCorrelationId: jest.fn().mockReturnValue('corr-1'),
  };

  const useCase = new DeleteOrganizationUseCase(
    prisma as never,
    events as never,
    requestContext as never,
  );

  jest
    .spyOn((useCase as any).logger, 'log')
    .mockImplementation(() => undefined);

  return { useCase, events, calls };
}

describe('exclusão de organização', () => {
  it('avisa as integrações só depois de a exclusão ser gravada', async () => {
    const h = harness();

    await h.useCase.execute(OWNER);

    expect(h.calls).toEqual([
      'soft-delete',
      'commit',
      'evento:organization.deleted',
    ]);
    expect(h.events.emitFrom).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        correlationId: 'corr-1',
      }),
      'organization.deleted',
      { actorId: 'acc-1' },
    );
  });

  it('não avisa nada quando a transação falha', async () => {
    const h = harness({ transactionFails: true });

    await expect(h.useCase.execute(OWNER)).rejects.toThrow('deadlock');

    expect(h.events.emitFrom).not.toHaveBeenCalled();
  });

  it('quem não é o dono canônico não exclui, e nada é avisado', async () => {
    const h = harness({ ownerId: 'outra-conta' });

    await expect(h.useCase.execute(OWNER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(h.events.emitFrom).not.toHaveBeenCalled();
  });
});
