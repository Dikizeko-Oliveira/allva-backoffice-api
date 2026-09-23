import { SubscriptionContextResolver } from './subscription-context.resolver';
import { OrganizationEntitlementView } from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';
import { OrganizationContractView } from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';

const DAY = 24 * 60 * 60 * 1000;

function trialingOrgView(
  overrides: Partial<OrganizationEntitlementView> = {},
): OrganizationEntitlementView {
  return {
    organizationSubscriptionId: 'orgsub-1',
    organizationId: 'org-1',
    planId: 'plan-ent',
    planName: 'ENTERPRISE',
    planType: 'ENTERPRISE',
    status: 'TRIALING',
    trialEndsAt: new Date(Date.now() + 7 * DAY),
    // Organização self-serve: sem contrato, e é o caso da maioria.
    contract: null,
    ...overrides,
  };
}

function activeAccountSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-acc-1',
    billingStatus: 'ACTIVE',
    accessStatus: 'ALLOWED',
    gracePeriodEndsAt: null,
    billingProvider: 'STRIPE',
    planId: 'plan-pro',
    plan: { name: 'PRO', type: 'PRO' },
    expiresAt: new Date(Date.now() + 30 * DAY),
    ...overrides,
  };
}

function buildResolver(flag = true) {
  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(null),
  };
  const organizationEntitlementRepository = {
    findEffectiveForAccount: jest.fn().mockResolvedValue(null),
    listExpiredTrials: jest.fn(),
    markExpired: jest.fn(),
  };
  const env = { get: jest.fn().mockReturnValue(flag) };

  const resolver = new SubscriptionContextResolver(
    subscriptionsRepository as any,
    organizationEntitlementRepository as any,
    env as any,
  );

  return {
    resolver,
    subscriptionsRepository,
    organizationEntitlementRepository,
  };
}

describe('SubscriptionContextResolver (org-scoped)', () => {
  it('grants ALLOWED to a provisioned owner with only a TRIALING org subscription (C-1)', async () => {
    const h = buildResolver();
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView(),
    );

    const ctx = await h.resolver.resolve('owner-account');

    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.canAccessProduct).toBe(true);
    expect(ctx.scope).toBe('ORGANIZATION');
    expect(ctx.organizationId).toBe('org-1');
    expect(ctx.planType).toBe('ENTERPRISE');
  });

  it('blocks product access when the trial window has already closed', async () => {
    const h = buildResolver();
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView({ trialEndsAt: new Date(Date.now() - DAY) }),
    );

    const ctx = await h.resolver.resolve('owner-account');

    expect(ctx.accessStatus).toBe('PAYMENT_REQUIRED');
    expect(ctx.canAccessProduct).toBe(false);
    expect(ctx.scope).toBe('ORGANIZATION');
  });

  it('honors the selected organization id when resolving', async () => {
    const h = buildResolver();
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView(),
    );

    await h.resolver.resolve('owner-account', { organizationId: 'org-42' });

    expect(
      h.organizationEntitlementRepository.findEffectiveForAccount,
    ).toHaveBeenCalledWith('owner-account', 'org-42');
  });

  it('falls back to the account subscription when there is no org subscription', async () => {
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      activeAccountSubscription(),
    );

    const ctx = await h.resolver.resolve('solo-account');

    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.scope).toBe('ACCOUNT');
    expect(ctx.provider).toBe('STRIPE');
  });

  it('returns the most permissive of account (paid) and org (expired trial)', async () => {
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      activeAccountSubscription(),
    );
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView({
        status: 'EXPIRED',
        trialEndsAt: new Date(Date.now() - DAY),
      }),
    );

    const ctx = await h.resolver.resolve('owner-paid');

    // Account is ACTIVE/ALLOWED, org trial EXPIRED -> account wins.
    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.scope).toBe('ACCOUNT');
  });

  it('returns the org trial when it is more permissive than a lapsed account sub', async () => {
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      activeAccountSubscription({
        billingStatus: 'EXPIRED',
        accessStatus: 'PAYMENT_REQUIRED',
      }),
    );
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView(),
    );

    const ctx = await h.resolver.resolve('owner-mixed');

    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.scope).toBe('ORGANIZATION');
  });

  it('ignores org subscriptions entirely when the feature flag is off', async () => {
    const h = buildResolver(false);
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView(),
    );

    const ctx = await h.resolver.resolve('owner-account');

    expect(ctx.accessStatus).toBe('BLOCKED');
    expect(ctx.scope).toBe('NONE');
    expect(
      h.organizationEntitlementRepository.findEffectiveForAccount,
    ).not.toHaveBeenCalled();
  });
});

describe('SubscriptionContextResolver — o FREE e o teste gratuito', () => {
  function freeAccountSubscription(overrides: Record<string, unknown> = {}) {
    return activeAccountSubscription({
      id: 'sub-free-1',
      billingStatus: 'TRIALING',
      billingProvider: null,
      planId: 'plan-free',
      plan: { name: 'Teste Gratuito', type: 'FREE' },
      ...overrides,
    });
  }

  it('libera o produto enquanto a janela do teste esta aberta', async () => {
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      freeAccountSubscription({ expiresAt: new Date(Date.now() + 3 * DAY) }),
    );

    const ctx = await h.resolver.resolve('acc-1');

    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.canAccessProduct).toBe(true);
    expect(ctx.planType).toBe('FREE');
  });

  it('exige contratacao quando a janela fecha — nao existe camada gratuita para onde cair', async () => {
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      freeAccountSubscription({ expiresAt: new Date(Date.now() - DAY) }),
    );

    const ctx = await h.resolver.resolve('acc-1');

    expect(ctx.accessStatus).toBe('PAYMENT_REQUIRED');
    expect(ctx.canAccessProduct).toBe(false);
    expect(ctx.canAccessSubscriptionsPage).toBe(true);
  });

  it('nao corta uma assinatura paga so porque o `expiresAt` gravado ficou para tras', async () => {
    // `syncWithProvider` nunca reescreve `expiresAt`, entao um plano pago pode
    // carregar uma data vencida enquanto a Stripe continua cobrando. A regra e
    // por tipo de plano justamente para nao confundir os dois casos.
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      activeAccountSubscription({ expiresAt: new Date(Date.now() - 30 * DAY) }),
    );

    const ctx = await h.resolver.resolve('acc-1');

    expect(ctx.accessStatus).toBe('ALLOWED');
    expect(ctx.canAccessProduct).toBe(true);
  });

  it('um FREE vencido na conta nao ressuscita acesso por ser o contexto mais permissivo', async () => {
    // `resolve()` devolve o maior entre conta e organizacao. Antes desta regra,
    // um FREE eterno na conta anulava a expiracao de trial da organizacao.
    const h = buildResolver();
    h.subscriptionsRepository.findByAccountId.mockResolvedValue(
      freeAccountSubscription({ expiresAt: new Date(Date.now() - DAY) }),
    );
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      trialingOrgView({ trialEndsAt: new Date(Date.now() - DAY) }),
    );

    const ctx = await h.resolver.resolve('acc-1');

    expect(ctx.accessStatus).toBe('PAYMENT_REQUIRED');
    expect(ctx.canAccessProduct).toBe(false);
  });
});

/**
 * O contrato manda sobre a assinatura da organização.
 *
 * Uma organização Enterprise nasce com assinatura `ACTIVE` e sem data, o que
 * sozinho concederia acesso para sempre. O contrato é quem fecha a porta — e
 * quem a mantém fechada quando o acordo foi suspenso ou encerrado.
 */
describe('contexto de uma organização sob contrato', () => {
  const DIA_MS = 24 * 60 * 60 * 1000;

  function comContrato(contract: OrganizationContractView | null) {
    return trialingOrgView({
      // A assinatura de contrato: ativa, sem prazo próprio.
      status: 'ACTIVE',
      trialEndsAt: null,
      contract,
    });
  }

  /**
   * Em dia com o financeiro, e o resto do acordo é papelada: a inadimplência e
   * a apresentação têm testes próprios, e o que se descreve aqui é a vigência.
   */
  const EM_DIA = {
    gracePeriodDays: 7,
    oldestUnpaidDueAt: null,
    id: 'contract-1',
    contractNumber: 'ENT-2026-0001',
    billingInterval: 'ANNUAL',
    paymentTerms: 'NET_30',
    paymentMethod: 'BOLETO',
    autoRenew: false,
  };

  const VIGENTE: OrganizationContractView = {
    status: 'ACTIVE',
    startsAt: new Date(Date.now() - 30 * DIA_MS),
    endsAt: new Date(Date.now() + 335 * DIA_MS),
    ...EM_DIA,
  };

  const VENCIDO: OrganizationContractView = {
    status: 'ACTIVE',
    startsAt: new Date(Date.now() - 400 * DIA_MS),
    endsAt: new Date(Date.now() - 1 * DIA_MS),
    ...EM_DIA,
  };

  function resolverCom(contract: OrganizationContractView | null) {
    const h = buildResolver();
    h.organizationEntitlementRepository.findEffectiveForAccount.mockResolvedValue(
      comContrato(contract),
    );
    return h.resolver;
  }

  it('concede acesso dentro da vigência', async () => {
    const context = await resolverCom(VIGENTE).resolve('acc-1');

    expect(context.accessStatus).toBe('ALLOWED');
    expect(context.canAccessProduct).toBe(true);
  });

  it('fecha quando a vigência termina, sem job nenhum ter rodado', async () => {
    const context = await resolverCom(VENCIDO).resolve('acc-1');

    /**
     * A assinatura da organização continua `ACTIVE` no banco — é o contrato
     * que decide. Sem esta composição, o cliente cujo contrato venceu seguiria
     * dentro do produto até alguém rodar alguma coisa.
     */
    expect(context.accessStatus).toBe('PAYMENT_REQUIRED');
    expect(context.canAccessProduct).toBe(false);
  });

  it('a suspensão do contrato fecha o produto', async () => {
    const context = await resolverCom({
      ...VIGENTE,
      status: 'SUSPENDED',
    }).resolve('acc-1');

    expect(context.canAccessProduct).toBe(false);
  });

  it('organização sem contrato segue decidindo pela assinatura', async () => {
    const context = await resolverCom(null).resolve('acc-1');

    // O caminho self-serve, que é a maioria: nada muda para ele.
    expect(context.accessStatus).toBe('ALLOWED');
    expect(context.managedByContract).toBe(false);
  });

  /**
   * Para onde o cliente de contrato é mandado quando algo trava.
   *
   * Este é o ponto em que a régua de autoatendimento erra feio. `/plans/
   * subscriptions` é o checkout de cartão: mandar para lá quem tem um acordo
   * negociado ofereceria um plano de tabela a quem já paga por contrato — e a
   * compra nem completaria, porque `subscription/change` recusa quem não tem
   * assinatura de conta.
   */
  describe('para onde o contrato manda quando o acesso fecha', () => {
    it('inadimplente vai para a cobrança, não para o checkout', async () => {
      const context = await resolverCom({
        ...VIGENTE,
        oldestUnpaidDueAt: new Date(Date.now() - 60 * DIA_MS),
      }).resolve('acc-1');

      expect(context.accessStatus).toBe('PAYMENT_REQUIRED');
      expect(context.redirectPath).toBe('/account/billing');
    });

    it('contrato vencido também', async () => {
      expect((await resolverCom(VENCIDO).resolve('acc-1')).redirectPath).toBe(
        '/account/billing',
      );
    });

    it('a vitrine de autoatendimento fica fechada', async () => {
      const context = await resolverCom(VENCIDO).resolve('acc-1');

      // Sem isto, o `PAYMENT_REQUIRED` abriria a página de contratação — que
      // é o comportamento certo para quem se autoatende e errado aqui.
      expect(context.canAccessSubscriptionsPage).toBe(false);
    });

    it('a tela de cobrança abre mesmo com o acesso fechado', async () => {
      const context = await resolverCom(VENCIDO).resolve('acc-1');

      // É onde ele vê a fatura em aberto e o número do contrato para ligar
      // para o comercial. Fechá-la deixaria o cliente sem caminho nenhum.
      expect(context.canAccessBillingPage).toBe(true);
    });

    it('em dia, nada disso muda o acesso ao produto', async () => {
      const context = await resolverCom(VIGENTE).resolve('acc-1');

      expect(context.managedByContract).toBe(true);
      expect(context.canAccessProduct).toBe(true);
      expect(context.redirectPath).toBeNull();
    });

    it('dentro da tolerância avisa, e ainda deixa trabalhar', async () => {
      const context = await resolverCom({
        ...VIGENTE,
        oldestUnpaidDueAt: new Date(Date.now() - 3 * DIA_MS),
      }).resolve('acc-1');

      expect(context.accessStatus).toBe('GRACE_PERIOD');
      expect(context.canAccessProduct).toBe(true);
      // O aviso leva à cobrança, onde a fatura em aberto está.
      expect(context.redirectPath).toBe('/account/billing');
    });
  });
});
