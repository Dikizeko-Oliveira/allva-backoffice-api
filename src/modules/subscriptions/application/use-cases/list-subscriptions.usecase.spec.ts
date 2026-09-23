import { ListSubscriptionsUseCase } from './list-subscriptions.usecase';

/**
 * O que a tela de cobrança responde — e para quem.
 *
 * Três públicos, e eles não se parecem: quem assina pelo cartão, quem ainda não
 * assinou nada, e quem fechou contrato. O terceiro era respondido como o
 * segundo, e é o que estes testes travam.
 */

const DIA = 24 * 60 * 60 * 1000;

const PLANOS = [
  { id: 'free', type: 'FREE', name: 'Free' },
  { id: 'pro', type: 'PRO', name: 'Pro' },
];

function contrato(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contract-1',
    contractNumber: 'ENT-2026-0007',
    status: 'ACTIVE',
    startsAt: new Date(Date.now() - 30 * DIA),
    endsAt: new Date(Date.now() + 335 * DIA),
    billingInterval: 'ANNUAL',
    paymentTerms: 'NET_30',
    paymentMethod: 'BOLETO',
    autoRenew: false,
    gracePeriodDays: 7,
    oldestUnpaidDueAt: null,
    ...overrides,
  };
}

function montar({
  subscription = null,
  entitlement = null,
}: {
  subscription?: unknown;
  entitlement?: unknown;
} = {}) {
  const organizationEntitlement = {
    findEffectiveForAccount: jest.fn().mockResolvedValue(entitlement),
  };

  const useCase = new ListSubscriptionsUseCase(
    { findByAccountId: jest.fn().mockResolvedValue(subscription) } as never,
    { listAll: jest.fn().mockResolvedValue(PLANOS) } as never,
    organizationEntitlement as never,
  );

  return { useCase, organizationEntitlement };
}

const orgEnterprise = (contract: unknown) => ({
  organizationSubscriptionId: 'org-sub-1',
  organizationId: 'org-1',
  planId: 'enterprise',
  planName: 'Enterprise',
  planType: 'ENTERPRISE',
  status: 'ACTIVE',
  trialEndsAt: null,
  contract,
});

describe('conta sob contrato Enterprise', () => {
  it('responde pelo contrato, e não "sem assinatura"', async () => {
    /**
     * Uma organização Enterprise é provisionada com assinatura de organização e
     * contrato, e **nenhuma** `Subscription` de conta — não há cartão nem
     * Stripe no caminho. Sem este ramo, o cliente que assinou um contrato anual
     * via a mesma tela de quem nunca contratou nada.
     */
    const { useCase } = montar({ entitlement: orgEnterprise(contrato()) });

    const resposta = await useCase.execute('account-1');

    expect(resposta.hasSubscription).toBe(true);
    expect(resposta.contract?.number).toBe('ENT-2026-0007');
    expect(resposta.message).toBeUndefined();
  });

  it('a assinatura devolvida é real, com o plano do contrato', async () => {
    const { useCase } = montar({ entitlement: orgEnterprise(contrato()) });

    const { subscription } = await useCase.execute('account-1');

    // `hasSubscription: true` com `subscription: null` seria contraditório, e
    // quebraria toda tela que lê `subscription.planId`.
    expect(subscription).toMatchObject({
      id: 'org-sub-1',
      planId: 'enterprise',
      planName: 'Enterprise',
      status: 'ACTIVE',
    });
  });

  it('as datas vêm do contrato, que é onde a vigência mora', async () => {
    const acordo = contrato();
    const { useCase } = montar({ entitlement: orgEnterprise(acordo) });

    const { subscription } = await useCase.execute('account-1');

    // A `OrganizationSubscription` nasce ACTIVE e sem prazo de propósito, para
    // não manter uma segunda cópia da vigência que envelhece na renegociação.
    expect(subscription?.startedAt).toEqual(acordo.startsAt);
    expect(subscription?.expiresAt).toEqual(acordo.endsAt);
  });

  it('não oferece vitrine de planos a quem tem acordo negociado', async () => {
    const { useCase } = montar({ entitlement: orgEnterprise(contrato()) });

    const { plans } = await useCase.execute('account-1');

    /**
     * Oferecer planos de autoatendimento aqui convidaria a uma troca que o
     * produto recusa, e mostraria um preço de tabela ao lado de um contrato
     * fechado por outro valor.
     */
    expect(plans).toEqual([]);
  });
});

describe('conta sem contrato', () => {
  it('sem assinatura nenhuma: continua sendo convidada a contratar', async () => {
    const { useCase } = montar();

    const resposta = await useCase.execute('account-1');

    expect(resposta.hasSubscription).toBe(false);
    expect(resposta.contract).toBeUndefined();
    // A vitrine é justamente para quem ainda não contratou nada.
    expect(resposta.plans).toHaveLength(1);
  });

  it('organização sem contrato não vira Enterprise por engano', async () => {
    const { useCase } = montar({ entitlement: orgEnterprise(null) });

    // Toda organização self-serve cai aqui — a maioria — e o contrato nulo é o
    // que a mantém no caminho de sempre.
    expect((await useCase.execute('account-1')).hasSubscription).toBe(false);
  });

  it('quem já assina pelo cartão nem consulta contrato', async () => {
    const { useCase, organizationEntitlement } = montar({
      subscription: {
        id: 'sub-1',
        planId: 'pro',
        status: 'ACTIVE',
        billingProvider: 'STRIPE',
        startedAt: new Date(),
        expiresAt: new Date(),
        plan: { type: 'PRO', name: 'Pro' },
      },
    });

    const resposta = await useCase.execute('account-1');

    // A esmagadora maioria das contas passa por aqui, e não deve pagar por uma
    // busca cujo resultado a resposta não usa.
    expect(
      organizationEntitlement.findEffectiveForAccount,
    ).not.toHaveBeenCalled();
    expect(resposta.subscription?.id).toBe('sub-1');
    expect(resposta.plans).toHaveLength(1);
  });

  it('o FREE fica fora da vitrine', async () => {
    const { useCase } = montar();

    const { plans } = await useCase.execute('account-1');

    // Ele não se contrata por aqui, e `subscription/change` recusa com
    // `FREE_CHANGE_NOT_ALLOWED` quem tentar.
    expect(plans.every((plan) => plan.type !== 'FREE')).toBe(true);
  });
});
