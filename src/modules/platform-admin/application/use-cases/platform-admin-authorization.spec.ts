import { ForbiddenException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  PLATFORM_ROLES,
  roleHasPlatformPermission,
  type PlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';
import {
  GetAdminAccountUseCase,
  GetAdminOrganizationUseCase,
  GetAdminOverviewUseCase,
  ListAdminAuditLogsUseCase,
  ListAdminCustomersUseCase,
  ListAdminIntegrationsUseCase,
  ListAdminInvoicesUseCase,
  ListAdminJobRunsUseCase,
  ListAdminOperatorsUseCase,
  ListAdminOrganizationsUseCase,
  ListAdminSubscriptionsUseCase,
} from './index';

const EMPTY_PAGE = { items: [], total: 0, page: 1, pageSize: 20 };

function accounts(role: string) {
  return { findById: jest.fn().mockResolvedValue({ id: 'ator-1', role }) };
}

function reader() {
  return {
    list: jest.fn().mockResolvedValue(EMPTY_PAGE),
    findById: jest.fn().mockResolvedValue({ id: 'x' }),
    listCustomers: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listOperators: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listSubscriptions: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listInvoices: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listIntegrations: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listJobRuns: jest.fn().mockResolvedValue(EMPTY_PAGE),
    listJobNames: jest.fn().mockResolvedValue([]),
    compute: jest.fn().mockResolvedValue({}),
  };
}

type Case = [string, PlatformPermission, (role: string) => Promise<unknown>];

const run =
  <T>(
    build: (r: never, p: PlatformRoleService) => T,
    call: (u: T) => Promise<unknown>,
  ) =>
  (role: string) =>
    call(
      build(
        reader() as never,
        new PlatformRoleService(accounts(role) as never),
      ),
    );

/**
 * Cada rota cross-org exige a permissão da sua área, e só ela.
 *
 * A tabela abaixo é a mesma fronteira de `platform-rbac.ts`, vista pelas
 * rotas: se uma delas passar a pedir outra permissão, o teste diz qual.
 */
const CASES: Case[] = [
  [
    'organizações',
    'orgs:read',
    run(
      (r, p) => new ListAdminOrganizationsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'organização',
    'orgs:read',
    run(
      (r, p) => new GetAdminOrganizationUseCase(r, p),
      (u) => u.execute('o-1', 'ator-1'),
    ),
  ],
  [
    'clientes',
    'users:read',
    run(
      (r, p) => new ListAdminCustomersUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'operadores',
    'users:read',
    run(
      (r, p) => new ListAdminOperatorsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'conta',
    'users:read',
    run(
      (r, p) => new GetAdminAccountUseCase(r, p),
      (u) => u.execute('a-1', 'ator-1'),
    ),
  ],
  [
    'assinaturas',
    'subscriptions:read',
    run(
      (r, p) => new ListAdminSubscriptionsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'faturas',
    'billing:read',
    run(
      (r, p) => new ListAdminInvoicesUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'integrações',
    'integrations:read',
    run(
      (r, p) => new ListAdminIntegrationsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'execuções de job',
    'operations:read',
    run(
      (r, p) => new ListAdminJobRunsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'auditoria',
    'audit:read',
    run(
      (r, p) => new ListAdminAuditLogsUseCase(r, p),
      (u) => u.execute({}, 'ator-1'),
    ),
  ],
  [
    'overview',
    'dashboard:read',
    (role) =>
      new GetAdminOverviewUseCase(
        accounts(role) as never,
        reader() as never,
      ).execute('ator-1'),
  ],
];

describe.each(CASES)('rota de %s exige %s', (_name, permission, call) => {
  it.each([...PLATFORM_ROLES, 'USER'])('papel %s', async (role) => {
    const allowed = roleHasPlatformPermission(role, permission);

    if (allowed) {
      await expect(call(role)).resolves.toBeDefined();
    } else {
      await expect(call(role)).rejects.toThrow(ForbiddenException);
    }
  });
});

describe('filtro de operadores por permissão', () => {
  it('traduz a permissão nos papéis que a têm, pela matriz do servidor', async () => {
    const r = reader();
    const useCase = new ListAdminOperatorsUseCase(
      r as never,
      new PlatformRoleService(accounts('ALLVA_ADMIN') as never),
    );

    await useCase.execute({ permission: 'support:manage' }, 'ator-1');

    expect(r.listOperators).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['ALLVA_ADMIN', 'ALLVA_SUPPORT'] }),
    );
  });
});

describe('overview devolve só as métricas da área', () => {
  it('comercial vê leads, e não receita', async () => {
    const r = reader();
    const output = await new GetAdminOverviewUseCase(
      accounts('ALLVA_SALES') as never,
      r as never,
    ).execute('ator-1');

    const keys = output.metrics.map((metric) => metric.key);
    expect(keys).toContain('leads.new_30d');
    expect(keys).not.toContain('billing.monthly_recurring');
  });
});
