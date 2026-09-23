import { SeatLimitService } from './seat-limit.service';

function member(active = true) {
  return { isActive: () => active };
}

function invitation(pending = true) {
  return { isPending: () => pending };
}

function buildService(options: {
  planType: string | null;
  members?: unknown[];
  invitations?: unknown[];
  /** Teto de contrato, quando existe. `undefined` = herda o plano. */
  negotiatedSeats?: number;
}) {
  const organizationUsersRepository = {
    listByOrganizationId: jest.fn().mockResolvedValue(options.members ?? []),
  };
  const invitationsRepository = {
    listByOrganizationId: jest
      .fn()
      .mockResolvedValue(options.invitations ?? []),
  };
  const organizationPlan = {
    findPlanTypeByOrganizationId: jest.fn().mockResolvedValue(options.planType),
  };

  const quotas = {
    findOverrides: jest.fn().mockResolvedValue({
      adAccounts: null,
      monitoredAds: null,
      seats: options.negotiatedSeats ?? null,
    }),
  };

  const service = new SeatLimitService(
    organizationUsersRepository as any,
    invitationsRepository as any,
    organizationPlan as any,
    quotas as any,
  );

  return { service, organizationUsersRepository, invitationsRepository };
}

describe('SeatLimitService.assertCanInvite', () => {
  it('allows an invite when seats remain on the plan', async () => {
    const h = buildService({
      planType: 'STARTER', // limit 3
      members: [member(), member()], // 2 active
    });

    await expect(h.service.assertCanInvite('org-1')).resolves.toBeUndefined();
  });

  it('counts pending invitations against the seat limit', async () => {
    const h = buildService({
      planType: 'STARTER', // limit 3
      members: [member(), member()], // 2 active
      invitations: [invitation()], // + 1 pending = 3
    });

    await expect(h.service.assertCanInvite('org-1')).rejects.toMatchObject({
      response: { code: 'SEAT_LIMIT_REACHED' },
    });
  });

  it('ignores inactive members and non-pending invitations', async () => {
    const h = buildService({
      planType: 'STARTER', // limit 3
      members: [member(), member(true), member(false)], // 2 active
      invitations: [invitation(false), invitation(false)], // 0 pending
    });

    await expect(h.service.assertCanInvite('org-1')).resolves.toBeUndefined();
  });

  it('o Enterprise deixou de ser ilimitado — aplica o piso do contrato', async () => {
    // Ilimitado era desconto disfarçado de entrega: quem tinha 50 assentos
    // pagava o mesmo que quem tinha 25. O piso do plano passa a valer, e o
    // número real de cada contrato vem do override.
    const h = buildService({
      planType: 'ENTERPRISE',
      members: Array.from({ length: 50 }, () => member()),
    });

    await expect(h.service.assertCanInvite('org-1')).rejects.toThrow();
  });

  it('o teto negociado vence o do plano', async () => {
    const h = buildService({
      planType: 'ENTERPRISE',
      members: Array.from({ length: 50 }, () => member()),
      negotiatedSeats: 80,
    });

    await expect(h.service.assertCanInvite('org-1')).resolves.toBeUndefined();
  });

  it('sem plano resolvível não há o que aplicar', async () => {
    const h = buildService({
      planType: null,
      members: Array.from({ length: 50 }, () => member()),
    });

    await expect(h.service.assertCanInvite('org-1')).resolves.toBeUndefined();
    // Abre na dúvida e nem conta assentos: recusar um convite legítimo por não
    // saber o plano é atrito que o cliente relata em minutos.
    expect(
      h.organizationUsersRepository.listByOrganizationId,
    ).not.toHaveBeenCalled();
  });

  it('fails open when no plan can be resolved for the organization', async () => {
    const h = buildService({ planType: null, members: [member(), member()] });

    await expect(h.service.assertCanInvite('org-1')).resolves.toBeUndefined();
  });
});

/**
 * O número que a tela mostra e o número que recusa o convite são o mesmo.
 *
 * A seção de membros exibia `members.length`, que não é assento: convite
 * pendente ocupa um e não aparece na lista, e membro bloqueado aparece e não
 * ocupa. A conta que a tela mostrava, portanto, não era a que recusava o
 * próximo convite — e "2 de 3" convivia com uma recusa por limite atingido.
 */
describe('SeatLimitService.resolve — o que a tela mostra', () => {
  it('assento é participação ativa mais convite pendente, nunca o tamanho da lista', async () => {
    const h = buildService({
      planType: 'PRO', // limite 10
      members: [member(), member(), member(false)], // 2 ativos, 1 inativo
      invitations: [invitation(), invitation(false)], // 1 pendente
    });

    await expect(h.service.resolve('org-1')).resolves.toEqual({
      limit: 10,
      used: 3,
      activeMembers: 2,
      pendingInvitations: 1,
    });
  });

  it('o teto negociado é o que a tela mostra - e não está em catálogo nenhum', async () => {
    const h = buildService({
      planType: 'ENTERPRISE', // piso 25
      members: Array.from({ length: 30 }, () => member()),
      negotiatedSeats: 80,
    });

    await expect(h.service.resolve('org-1')).resolves.toMatchObject({
      limit: 80,
      used: 30,
    });
  });

  it('conta mesmo sem plano resolvível, onde a guarda abre sem contar', async () => {
    // A assimetria é o ponto: não há nada a recusar, mas a tela ainda tem um
    // número verdadeiro a exibir ao lado da lista.
    const h = buildService({ planType: null, members: [member(), member()] });

    await expect(h.service.resolve('org-1')).resolves.toEqual({
      limit: null,
      used: 2,
      activeMembers: 2,
      pendingInvitations: 0,
    });
  });

  it('o exibido bate com o aplicado: cheio na tela é recusa no convite', async () => {
    const full = {
      planType: 'STARTER' as const, // limite 3
      members: [member(), member()],
      invitations: [invitation()], // 2 + 1 = 3
    };

    const shown = await buildService(full).service.resolve('org-1');
    const refused = await buildService(full)
      .service.assertCanInvite('org-1')
      .then(() => false)
      .catch(() => true);

    expect(shown.used >= (shown.limit ?? Infinity)).toBe(refused);
  });
});
