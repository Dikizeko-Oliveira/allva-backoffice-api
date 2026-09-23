import { OrganizationContextResolver } from './organization-context.resolver';
import { GetMeContextUseCase } from './use-cases/get-me-context.usecase';
import { PermissionResolverService } from './permission-resolver.service';
import { organizationWorkspace } from './workspace-context';

/**
 * Onde a conta está quando a requisição não nomeia organização.
 *
 * O defeito que estes testes fixam era visível na tela: `GET /organizations`
 * respondia 200 e a tela ficava em skeleton eterno. A causa não estava nela —
 * estava em `GET /auth/me`, que o controller declara ser a fonte de verdade de
 * autorização do frontend, respondendo um workspace pessoal com permissões
 * pessoais. Dados em mãos, nenhuma autoridade para exibi-los.
 *
 * Havia três respostas para "onde estou": o middleware dizia "pessoal", enquanto
 * `CurrentOrganizationResolver` e `OwnerScopeResolverService` caíam na
 * organização padrão. Estes testes prendem a resposta única.
 */

function membership(
  id: string,
  organizationId: string,
  options: { active?: boolean; role?: string } = {},
) {
  return {
    id,
    organizationId,
    role: options.role ?? 'OWNER',
    status: 'ACTIVE',
    isActive: () => options.active ?? true,
  };
}

function buildResolver(options: {
  memberships?: ReturnType<typeof membership>[];
  aliveOrganizationIds?: string[];
  owned?: { id: string } | null;
}) {
  const organizationUsers = {
    listByAccountId: jest.fn().mockResolvedValue(options.memberships ?? []),
    findByOrganizationIdAndAccountId: jest.fn(),
  };
  const organizations = {
    listByIds: jest
      .fn()
      .mockResolvedValue(
        (options.aliveOrganizationIds ?? []).map((id) => ({ id })),
      ),
    findByOwnerId: jest.fn().mockResolvedValue(options.owned ?? null),
  };

  return new OrganizationContextResolver(
    organizationUsers as never,
    organizations as never,
  );
}

describe('a organização padrão de uma requisição sem header', () => {
  it('resolve a participação ativa da conta', async () => {
    const resolver = buildResolver({
      memberships: [membership('m-1', 'org-1', { role: 'ADMIN' })],
      aliveOrganizationIds: ['org-1'],
    });

    await expect(resolver.resolveDefault('acc-1')).resolves.toEqual({
      organizationId: 'org-1',
      accountId: 'acc-1',
      membershipId: 'm-1',
      role: 'ADMIN',
    });
  });

  it('participação congelada NÃO concede contexto', async () => {
    /**
     * Assimetria deliberada com `OrganizationProvisioningService`: lá a pergunta
     * é "pertence" e o congelado conta; aqui o contexto alimenta guards e o
     * tenant do banco, então congelamento por teto de assentos tem de barrar. Se
     * herdasse a resposta de lá, um downgrade de plano deixaria de valer.
     */
    const resolver = buildResolver({
      memberships: [membership('m-1', 'org-1', { active: false })],
      aliveOrganizationIds: ['org-1'],
      owned: null,
    });

    await expect(resolver.resolveDefault('acc-1')).resolves.toBeNull();
  });

  it('participação cuja organização foi apagada não vale', async () => {
    const resolver = buildResolver({
      memberships: [membership('m-1', 'org-apagada')],
      aliveOrganizationIds: [],
      owned: null,
    });

    await expect(resolver.resolveDefault('acc-1')).resolves.toBeNull();
  });

  it('dono sem participação é atendido com membershipId nulo, não vazio', async () => {
    // Estado degradado de dado legado. `''` passaria por qualquer checagem de
    // presença sem identificar participação nenhuma.
    const resolver = buildResolver({ owned: { id: 'org-propria' } });

    await expect(resolver.resolveDefault('acc-1')).resolves.toEqual({
      organizationId: 'org-propria',
      accountId: 'acc-1',
      membershipId: null,
      role: 'OWNER',
    });
  });

  it('conta que não alcança organização nenhuma devolve null', async () => {
    const resolver = buildResolver({ owned: null });

    await expect(resolver.resolveDefault('acc-1')).resolves.toBeNull();
  });
});

function buildMeContext(options: {
  memberships: ReturnType<typeof membership>[];
  organizations: { id: string; name: string }[];
  role?: string;
}) {
  const accounts = {
    findById: jest.fn().mockResolvedValue({
      id: 'acc-1',
      name: 'Kevin',
      email: 'k@e.com',
      role: options.role ?? 'USER',
    }),
  };
  const organizationUsers = {
    listByAccountId: jest.fn().mockResolvedValue(options.memberships),
  };
  const organizations = {
    listByIds: jest.fn().mockResolvedValue(options.organizations),
  };

  const onboarding = {
    resolve: jest.fn().mockResolvedValue({
      hasOrganization: true,
      hasActiveSubscription: true,
      hasConnectedIntegration: false,
      hasLinkedAdAccount: false,
      hasSyncedAds: false,
      nextStep: 'CONNECT_PLATFORM',
    }),
  };

  return new GetMeContextUseCase(
    accounts as never,
    organizationUsers as never,
    organizations as never,
    new PermissionResolverService(),
    onboarding as never,
  );
}

describe('GET /auth/me — o que o frontend usa para decidir o que renderizar', () => {
  it('devolve permissões de organização, e não o conjunto pessoal', async () => {
    const active = membership('m-1', 'org-1');
    const useCase = buildMeContext({
      memberships: [active],
      organizations: [{ id: 'org-1', name: 'Kevin de Oliveira' }],
    });

    const result = await useCase.execute(
      'acc-1',
      organizationWorkspace({
        organizationId: 'org-1',
        accountId: 'acc-1',
        membershipId: 'm-1',
        role: 'OWNER',
      }),
    );

    expect(result.currentWorkspace).toEqual({
      type: 'ORGANIZATION',
      organizationId: 'org-1',
      role: 'OWNER',
    });
    expect(result.membership).not.toBeNull();

    // Era esta a lista que chegava vazia de organização e travava a tela.
    expect(result.permissions).toContain('organization:read');
    expect(result.permissions).toContain('members:read');
    expect(result.permissions).not.toContain('manage_personal_billing');
  });

  it('não oferece workspace pessoal a quem tem organização', async () => {
    // O item fantasma do seletor: aparecia ao lado da organização como se
    // fossem escolhas equivalentes, e levava a um lugar sem nada para mostrar.
    const useCase = buildMeContext({
      memberships: [membership('m-1', 'org-1')],
      organizations: [{ id: 'org-1', name: 'Kevin de Oliveira' }],
    });

    const result = await useCase.execute('acc-1');

    expect(result.availableWorkspaces).toEqual([
      {
        type: 'ORGANIZATION',
        organizationId: 'org-1',
        name: 'Kevin de Oliveira',
        role: 'OWNER',
      },
    ]);
  });

  it('conta sem organização não recebe workspace alternativo nem permissões', async () => {
    // O `{ type: 'PERSONAL' }` fixo que existia aqui prometia um destino que o
    // produto não tem, e as permissões pessoais que o acompanhavam não eram
    // verificadas por guard nenhum.
    const useCase = buildMeContext({ memberships: [], organizations: [] });

    const result = await useCase.execute('acc-1');

    expect(result.availableWorkspaces).toEqual([]);
    expect(result.currentWorkspace).toEqual({ type: 'NO_ORGANIZATION' });
    // Nenhuma permissão, porque é o que é verdade: recurso de organização
    // exige contexto de organização.
    expect(result.permissions).toEqual([]);
  });
});

/**
 * B0 do mapa de endpoints do backoffice — o que travava o painel inteiro.
 *
 * Sem estes dois campos o backoffice não sabia se quem entrou era operador, e
 * todo o RBAC dele vivia de mock.
 */
describe('GET /auth/me — papel de plataforma', () => {
  it('conta de cliente: papel nulo e nenhuma permissão de plataforma', async () => {
    const useCase = buildMeContext({ memberships: [], organizations: [] });

    const result = await useCase.execute('acc-1');

    expect(result.platformRole).toBeNull();
    expect(result.platformPermissions).toEqual([]);
  });

  it('operador: papel e permissões já resolvidos pela matriz do servidor', async () => {
    const useCase = buildMeContext({
      memberships: [],
      organizations: [],
      role: 'ALLVA_SUPPORT',
    });

    const result = await useCase.execute('acc-1');

    expect(result.platformRole).toBe('ALLVA_SUPPORT');
    expect(result.platformPermissions).toContain('support:manage');
    // O motivo de o papel existir: o suporte não mexe em dinheiro.
    expect(result.platformPermissions).not.toContain('billing:manage');
  });

  /**
   * Papel e permissão de organização não se misturam: o dono de uma
   * organização não vira operador, e o operador não ganha permissão dentro
   * de organização nenhuma por ser operador.
   */
  it('os dois eixos não se contaminam', async () => {
    const useCase = buildMeContext({
      memberships: [membership('m-1', 'org-1')],
      organizations: [{ id: 'org-1', name: 'Kevin de Oliveira' }],
    });

    const result = await useCase.execute(
      'acc-1',
      organizationWorkspace({
        organizationId: 'org-1',
        accountId: 'acc-1',
        membershipId: 'm-1',
        role: 'OWNER',
      }),
    );

    expect(result.permissions).toContain('organization:read');
    expect(result.platformRole).toBeNull();
    expect(result.platformPermissions).toEqual([]);
  });
});
