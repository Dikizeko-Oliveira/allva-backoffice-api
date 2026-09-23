import { OrganizationPlanPrismaRepository } from './organization-plan-prisma.repository';

const DAY = 24 * 60 * 60 * 1000;

function buildRepo(row: unknown) {
  const prisma = {
    organizationSubscription: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
  };

  return {
    repo: new OrganizationPlanPrismaRepository(prisma as never),
    prisma,
  };
}

describe('o plano que governa a organização', () => {
  it('sem queda agendada, é o plano vigente', async () => {
    const { repo } = buildRepo({
      status: 'ACTIVE',
      plan: { type: 'PRO' },
      pendingPlanEffectiveAt: null,
      pendingPlan: null,
    });

    expect(await repo.findPlanTypeByOrganizationId('org-1')).toBe('PRO');
  });

  it('com queda agendada para o futuro, ainda é o vigente', async () => {
    // O cliente pagou o período. Aplicar antes tiraria o que ele comprou.
    const { repo } = buildRepo({
      status: 'ACTIVE',
      plan: { type: 'PRO' },
      pendingPlanEffectiveAt: new Date(Date.now() + 5 * DAY),
      pendingPlan: { type: 'STARTER' },
    });

    expect(await repo.findPlanTypeByOrganizationId('org-1')).toBe('PRO');
  });

  it('passada a data, o plano pendente É o plano — sem job nenhum', async () => {
    /**
     * A regra que faz o downgrade existir de verdade. Quem aplicaria a virada é
     * o webhook da Stripe; se ele falhar, a organização continuaria com os
     * limites do plano que deixou de pagar — que é exatamente o buraco que
     * permitiria assinar o caro, descer e manter tudo.
     */
    const { repo } = buildRepo({
      status: 'ACTIVE',
      plan: { type: 'PRO' },
      pendingPlanEffectiveAt: new Date(Date.now() - DAY),
      pendingPlan: { type: 'STARTER' },
    });

    expect(await repo.findPlanTypeByOrganizationId('org-1')).toBe('STARTER');
  });

  it('organização sem assinatura devolve nulo', async () => {
    const { repo } = buildRepo(null);

    expect(await repo.findPlanTypeByOrganizationId('org-1')).toBeNull();
  });
});

describe('as duas assimetrias de tempo', () => {
  it('a queda espera a data', async () => {
    const { repo, prisma } = buildRepo({ plan: { type: 'PRO' } });
    const effectiveAt = new Date(Date.now() + 5 * DAY);

    await repo.scheduleDowngrade({
      organizationId: 'org-1',
      planId: 'plan-starter',
      effectiveAt,
    });

    // `planId` NÃO muda: o entitlement é lido dele até a data chegar.
    expect(prisma.organizationSubscription.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      data: {
        pendingPlanId: 'plan-starter',
        pendingPlanEffectiveAt: effectiveAt,
      },
    });
  });

  it('a subida vale na hora e cancela a queda pendente', async () => {
    const { repo, prisma } = buildRepo({ plan: { type: 'STARTER' } });

    await repo.applyUpgrade({ organizationId: 'org-1', planId: 'plan-pro' });

    expect(prisma.organizationSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1' },
        update: {
          planId: 'plan-pro',
          status: 'ACTIVE',
          pendingPlanId: null,
          pendingPlanEffectiveAt: null,
        },
      }),
    );
  });

  /**
   * `updateMany` não falha quando não encontra nada — apenas não faz nada. Uma
   * organização sem assinatura absorvia o upgrade em silêncio e seguia com plano
   * nulo, ou seja, com as dezesseis guardas negando tudo a quem acabou de pagar.
   */
  it('a subida cria a assinatura quando a organização não tem nenhuma', async () => {
    const { repo, prisma } = buildRepo(null);

    await repo.applyUpgrade({ organizationId: 'org-1', planId: 'plan-pro' });

    const [call] = prisma.organizationSubscription.upsert.mock.calls[0];
    expect(call.create).toMatchObject({
      organizationId: 'org-1',
      planId: 'plan-pro',
      status: 'ACTIVE',
      // Quem sobe de plano pagando não está em teste: janela aberta, que o
      // `lte` de `listExpiredTrials` nunca alcança.
      trialEndsAt: null,
    });
  });
});

/**
 * O plano pago desce para a organização quando a Stripe confirma.
 *
 * A primeira assinatura não passa por `ChangeSubscriptionUseCase` — ela nasce
 * `PENDING_PAYMENT` e é o webhook que a ativa —, então sem esta propagação a
 * organização ficava no teste FREE. Como o FREE espelha o PRO, um cliente do
 * Individual recebia calado o que o Profissional entrega.
 */
describe('propagação do plano pago para as organizações do dono', () => {
  it('alinha as organizações vivas da conta ao plano pago', async () => {
    const { repo, prisma } = buildRepo(null);

    await repo.syncPlanForOwner({
      ownerAccountId: 'acc-1',
      planId: 'plan-starter',
    });

    expect(prisma.organizationSubscription.updateMany).toHaveBeenCalledWith({
      where: { organization: { ownerId: 'acc-1', deletedAt: null } },
      data: { planId: 'plan-starter', status: 'ACTIVE' },
    });
  });

  it('não toca a queda agendada', async () => {
    // `invoice.paid` chega em toda renovação. Limpar `pendingPlanId` aqui faria
    // o downgrade agendado nunca aterrissar.
    const { repo, prisma } = buildRepo(null);

    await repo.syncPlanForOwner({
      ownerAccountId: 'acc-1',
      planId: 'plan-pro',
    });

    const [call] = prisma.organizationSubscription.updateMany.mock.calls[0];
    expect(call.data).not.toHaveProperty('pendingPlanId');
    expect(call.data).not.toHaveProperty('pendingPlanEffectiveAt');
  });
});

/**
 * Só três lugares escreviam `status` aqui, e os três para cima: `applyUpgrade`,
 * `syncPlanForOwner` (ambos `ACTIVE`) e a expiração de teste, que só varre
 * `TRIALING`. Nada trazia uma organização de volta de `ACTIVE` — uma vez paga,
 * ficava paga no banco para sempre, e o produto seguia aberto depois de a
 * cobrança acabar.
 */
describe('revogação do acesso quando a conta para de pagar', () => {
  it('fecha as organizações vivas do dono', async () => {
    const { repo, prisma } = buildRepo(null);

    await repo.revokeForOwner({
      ownerAccountId: 'acc-1',
      status: 'CANCELED',
    });

    expect(prisma.organizationSubscription.updateMany).toHaveBeenCalledWith({
      where: { organization: { ownerId: 'acc-1', deletedAt: null } },
      data: { status: 'CANCELED' },
    });
  });

  it('preserva o plano — o que se perde é o acesso, não o histórico', async () => {
    const { repo, prisma } = buildRepo(null);

    await repo.revokeForOwner({ ownerAccountId: 'acc-1', status: 'EXPIRED' });

    const [call] = prisma.organizationSubscription.updateMany.mock.calls[0];
    expect(call.data).not.toHaveProperty('planId');
  });

  it('devolve quantas linhas mudaram, para o zero poder ser denunciado', async () => {
    const { repo, prisma } = buildRepo(null);
    prisma.organizationSubscription.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repo.revokeForOwner({ ownerAccountId: 'acc-1', status: 'CANCELED' }),
    ).resolves.toBe(0);
  });
});

/**
 * A leitura ignorava `status` e devolvia o plano fosse qual fosse o estado. Com
 * o acesso revogado, as dezesseis guardas de `ENFORCED_FEATURE_KEYS` — que leem
 * esta porta direto, sem passar pelo resolver — seguiriam entregando o plano
 * pago a quem não paga mais.
 */
describe('um plano que não vale mais não é plano', () => {
  it.each(['CANCELED', 'EXPIRED', 'UNPAID', 'INCOMPLETE', 'PAUSED'])(
    'devolve nulo com status %s',
    async (status) => {
      const { repo } = buildRepo({
        status,
        plan: { type: 'PRO' },
        pendingPlanEffectiveAt: null,
        pendingPlan: null,
      });

      expect(await repo.findPlanTypeByOrganizationId('org-1')).toBeNull();
    },
  );

  it.each(['TRIALING', 'ACTIVE', 'PAST_DUE'])(
    'mantém o plano com status %s',
    async (status) => {
      // PAST_DUE entra: tirar o plano no primeiro boleto atrasado puniria quem
      // só tem uma cobrança a reprocessar, e a graça existe para isso.
      const { repo } = buildRepo({
        status,
        plan: { type: 'PRO' },
        pendingPlanEffectiveAt: null,
        pendingPlan: null,
      });

      expect(await repo.findPlanTypeByOrganizationId('org-1')).toBe('PRO');
    },
  );
});

/**
 * Suporte não é capacidade de produto, e não pode morrer com o acesso.
 *
 * `support-email` é uma `EnforcedFeatureKey` como as outras, mas responde outra
 * pergunta: não "esta organização pode usar isto?", e sim "que atendimento esta
 * conta contratou?". Quando a leitura de plano passou a fechar em nulo com o
 * acesso revogado, ela levou junto o canal de abrir chamado — de quem mais
 * precisa dele, e quase sempre sobre a própria cobrança.
 */
describe('o plano contratado, valendo ou não', () => {
  it.each(['CANCELED', 'EXPIRED', 'UNPAID'])(
    'devolve o plano mesmo com status %s',
    async (status) => {
      const { repo } = buildRepo({
        status,
        plan: { type: 'PRO' },
        pendingPlanEffectiveAt: null,
        pendingPlan: null,
      });

      // A leitura de acesso fecha; a de contrato não.
      expect(await repo.findPlanTypeByOrganizationId('org-1')).toBeNull();
      expect(await repo.findContractedPlanTypeByOrganizationId('org-1')).toBe(
        'PRO',
      );
    },
  );

  it('continua respeitando a queda agendada já vencida', async () => {
    const { repo } = buildRepo({
      status: 'CANCELED',
      plan: { type: 'PRO' },
      pendingPlanEffectiveAt: new Date(Date.now() - DAY),
      pendingPlan: { type: 'STARTER' },
    });

    expect(await repo.findContractedPlanTypeByOrganizationId('org-1')).toBe(
      'STARTER',
    );
  });

  it('organização sem assinatura devolve nulo nas duas leituras', async () => {
    const { repo } = buildRepo(null);

    expect(
      await repo.findContractedPlanTypeByOrganizationId('org-1'),
    ).toBeNull();
  });
});
