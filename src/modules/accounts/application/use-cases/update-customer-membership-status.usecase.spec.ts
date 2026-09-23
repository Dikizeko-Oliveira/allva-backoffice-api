import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PlatformRoleService } from '../services/platform-role.service';
import { UpdateCustomerMembershipStatusUseCase } from './update-customer-membership-status.usecase';

function membership(options: {
  status?: 'ACTIVE' | 'BLOCKED';
  owner?: boolean;
  active?: boolean;
}) {
  return {
    id: 'membership',
    status: options.status ?? 'ACTIVE',
    isDeleted: () => false,
    isOwner: () => options.owner ?? false,
    isActive: () => options.active ?? options.status !== 'BLOCKED',
    activate() {
      this.status = 'ACTIVE';
    },
    block() {
      this.status = 'BLOCKED';
    },
  };
}

function build(options: {
  actorRole?: string;
  target?: ReturnType<typeof membership> | null;
  activeOwners?: number;
}) {
  const accounts = {
    actor: { id: 'actor', role: options.actorRole ?? 'ALLVA_ADMIN' },
  };
  const target = options.target === undefined ? membership({}) : options.target;
  const organizationUsersRepository = {
    findByOrganizationIdAndAccountId: jest.fn().mockResolvedValue(target),
    countActiveOwners: jest.fn().mockResolvedValue(options.activeOwners ?? 2),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const accountsRepository = {
    findById: jest.fn(async (id: string) => accounts[id] ?? null),
  };
  const record = jest.fn().mockResolvedValue(undefined);

  const useCase = new UpdateCustomerMembershipStatusUseCase(
    new PlatformRoleService(accountsRepository as never),
    organizationUsersRepository as never,
    { record } as never,
  );
  (useCase as unknown as { logger: { log: () => void } }).logger.log = () =>
    undefined;

  return { useCase, organizationUsersRepository, record };
}

describe('UpdateCustomerMembershipStatusUseCase', () => {
  it('exige users:manage', async () => {
    const h = build({ actorRole: 'ALLVA_SUPPORT' });

    await expect(
      h.useCase.execute(
        'account',
        'organization',
        { status: 'BLOCKED', reason: 'fraude confirmada' },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.organizationUsersRepository.update).not.toHaveBeenCalled();
  });

  it('bloqueia a participação e audita motivo', async () => {
    const h = build({});

    const result = await h.useCase.execute(
      'account',
      'organization',
      { status: 'BLOCKED', reason: 'fraude confirmada' },
      'actor',
    );

    expect(result).toEqual({ id: 'membership', status: 'BLOCKED' });
    expect(h.organizationUsersRepository.update).toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'member.status.updated',
        entityId: 'membership',
        actorId: 'actor',
        organizationId: 'organization',
        metadata: expect.objectContaining({
          targetAccountId: 'account',
          from: 'ACTIVE',
          to: 'BLOCKED',
          reason: 'fraude confirmada',
          source: 'platform_admin',
        }),
      }),
    );
  });

  it('preserva o último proprietário ativo', async () => {
    const h = build({
      target: membership({ owner: true, active: true }),
      activeOwners: 1,
    });

    await expect(
      h.useCase.execute(
        'account',
        'organization',
        { status: 'BLOCKED', reason: 'fraude confirmada' },
        'actor',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.organizationUsersRepository.update).not.toHaveBeenCalled();
  });
});
