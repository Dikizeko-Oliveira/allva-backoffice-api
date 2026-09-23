import { ListMyOrganizationsUseCase } from './list-my-organizations.usecase';

function membership(organizationId: string, role: string, active = true) {
  return { organizationId, role, isActive: () => active };
}

function organization(id: string, name: string) {
  return { id, name };
}

function build(options: {
  owned?: { id: string; name: string }[];
  memberships?: ReturnType<typeof membership>[];
  all?: { id: string; name: string }[];
  /** `accessStatus` por organização; ausente = ALLOWED. */
  access?: Record<string, string>;
}) {
  const { owned = [], memberships = [], all = [], access = {} } = options;

  const organizationsRepository = {
    listByOwnerId: jest.fn().mockResolvedValue(owned),
    listByIds: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        all.filter((organization) => ids.includes(organization.id)),
      ),
  };

  const organizationUsersRepository = {
    listByAccountId: jest.fn().mockResolvedValue(memberships),
  };

  const subscriptions = {
    resolve: jest
      .fn()
      .mockImplementation(
        (_accountId: string, o: { organizationId: string }) => ({
          accessStatus: access[o.organizationId] ?? 'ALLOWED',
        }),
      ),
  };

  return {
    service: new ListMyOrganizationsUseCase(
      organizationsRepository as never,
      organizationUsersRepository as never,
      subscriptions as never,
    ),
    organizationsRepository,
    subscriptions,
  };
}

describe('as organizações que a conta alcança', () => {
  it('une posse e participação sem repetir', async () => {
    // Criar uma organização grava as duas coisas: `ownerId` e a participação
    // OWNER. Sem deduplicar, a própria organização apareceria duas vezes no
    // seletor — no caso mais comum de todos.
    const h = build({
      owned: [organization('org-a', 'Alfa')],
      memberships: [membership('org-a', 'OWNER')],
      all: [organization('org-a', 'Alfa')],
    });

    const result = await h.service.execute('acc-1');

    expect(result).toEqual([
      {
        id: 'org-a',
        name: 'Alfa',
        isOwner: true,
        role: 'OWNER',
        accessStatus: 'ALLOWED',
      },
    ]);
  });

  it('inclui organização em que a conta só participa', async () => {
    const h = build({
      memberships: [membership('org-b', 'ANALYST')],
      all: [organization('org-b', 'Beta')],
    });

    expect(await h.service.execute('acc-1')).toEqual([
      {
        id: 'org-b',
        name: 'Beta',
        isOwner: false,
        role: 'ANALYST',
        accessStatus: 'ALLOWED',
      },
    ]);
  });

  it('inclui organização própria sem participação ativa', async () => {
    /**
     * Estado degradado, não impossível: a transferência de posse move `ownerId`
     * sem mexer nas participações, e uma participação pode ser desativada. Se o
     * seletor só olhasse participação, o dono perderia acesso à própria
     * organização pela tela — e nem saberia por quê.
     */
    const h = build({
      owned: [organization('org-c', 'Gama')],
      memberships: [membership('org-c', 'OWNER', false)],
      all: [organization('org-c', 'Gama')],
    });

    expect(await h.service.execute('acc-1')).toEqual([
      {
        id: 'org-c',
        name: 'Gama',
        isOwner: true,
        role: null,
        accessStatus: 'ALLOWED',
      },
    ]);
  });

  it('ignora participação inativa em organização alheia', async () => {
    const h = build({
      memberships: [membership('org-d', 'MEMBER', false)],
      all: [organization('org-d', 'Delta')],
    });

    expect(await h.service.execute('acc-1')).toEqual([]);
  });

  it('não consulta o banco quando não há nada a listar', async () => {
    const h = build({});

    expect(await h.service.execute('acc-1')).toEqual([]);
    expect(h.organizationsRepository.listByIds).not.toHaveBeenCalled();
  });

  it('ordena por nome, para o seletor não trocar de ordem entre visitas', async () => {
    const h = build({
      owned: [organization('org-z', 'Zeta'), organization('org-a', 'Alfa')],
      memberships: [membership('org-m', 'ADMIN')],
      all: [
        organization('org-z', 'Zeta'),
        organization('org-a', 'Alfa'),
        organization('org-m', 'Meta'),
      ],
    });

    const names = (await h.service.execute('acc-1')).map((row) => row.name);

    expect(names).toEqual(['Alfa', 'Meta', 'Zeta']);
  });
});

describe('o status de cada organização', () => {
  it('vem por organização, não o da ativa', async () => {
    /**
     * A armadilha que isto existe para desarmar: com uma organização vencida e
     * outra em dia, o seletor listava as duas iguais. Quem trocasse às cegas
     * caía na vencida e via o produto inteiro recusar, sem a tela onde escolheu
     * ter dito qual era o problema.
     */
    const h = build({
      owned: [organization('org-a', 'Alfa'), organization('org-b', 'Beta')],
      all: [organization('org-a', 'Alfa'), organization('org-b', 'Beta')],
      access: { 'org-a': 'BLOCKED', 'org-b': 'ALLOWED' },
    });

    const result = await h.service.execute('acc-1');

    expect(result.map((row) => [row.name, row.accessStatus])).toEqual([
      ['Alfa', 'BLOCKED'],
      ['Beta', 'ALLOWED'],
    ]);
  });

  it('resolve uma vez por organização', async () => {
    const h = build({
      owned: [organization('org-a', 'Alfa'), organization('org-b', 'Beta')],
      all: [organization('org-a', 'Alfa'), organization('org-b', 'Beta')],
    });

    await h.service.execute('acc-1');

    expect(h.subscriptions.resolve).toHaveBeenCalledTimes(2);
  });
});
