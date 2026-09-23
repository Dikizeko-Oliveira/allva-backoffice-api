import { CreateSubscriptionUseCase } from './create-subscription.usecase';

/**
 * Pins that a paid subscription is created on Stripe.
 *
 * The default used to be Mercado Pago, so any client that omitted `billingProvider`
 * silently got a Mercado Pago subscription on a product billed through Stripe. The
 * provider is gone now, but the default is still a string literal no type checker
 * guards — hence this test.
 */

const PAID_PLAN = {
  id: 'plan-pro',
  type: 'PRO',
  name: 'Pro',
  amount: 149.9,
  stripePriceId: 'price_pro',
  trialDays: null,
};

function buildHarness({ plan = PAID_PLAN }: { plan?: unknown } = {}) {
  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({
      id: 'acc-1',
      email: 'ana@example.com',
      name: 'Ana',
      stripeCustomerId: 'cus_1',
    }),
    attachStripeCustomer: jest.fn().mockResolvedValue(undefined),
  };

  const plansRepository = {
    findById: jest.fn().mockResolvedValue(plan),
    findByType: jest.fn().mockResolvedValue(plan),
  };

  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const stripeService = {
    validateStripePrice: jest.fn().mockResolvedValue(undefined),
    ensureStripeCustomer: jest
      .fn()
      .mockResolvedValue({ stripeCustomerId: 'cus_1' }),
    createStripeSubscription: jest.fn().mockResolvedValue({
      externalSubscriptionId: 'sub_stripe_1',
      status: 'INCOMPLETE',
      currentPeriodEnd: new Date('2026-08-25T00:00:00.000Z'),
      clientSecret: 'pi_secret',
    }),
  };

  const useCase = new CreateSubscriptionUseCase(
    accountsRepository as never,
    plansRepository as never,
    subscriptionsRepository as never,
    stripeService as never,
  );

  for (const level of ['log', 'warn', 'error'] as const) {
    const logger = (useCase as any).logger;
    if (logger?.[level]) {
      jest.spyOn(logger, level).mockImplementation(() => undefined);
    }
  }

  return { useCase, stripeService, subscriptionsRepository };
}

describe('CreateSubscriptionUseCase — provider selection', () => {
  it('creates the subscription on Stripe when no provider is given', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1', { planId: 'plan-pro' } as never);

    expect(h.stripeService.createStripeSubscription).toHaveBeenCalled();
  });

  it('records STRIPE as the billing provider on the saved subscription', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1', { planId: 'plan-pro' } as never);

    const [saved] = h.subscriptionsRepository.save.mock.calls[0];
    expect(saved.billingProvider).toBe('STRIPE');
  });

  it('returns the Stripe client secret so the client can confirm payment', async () => {
    const h = buildHarness();

    const result = await h.useCase.execute('acc-1', {
      planId: 'plan-pro',
    } as never);

    expect(result.clientSecret).toBe('pi_secret');
    expect(result.billingProvider).toBe('STRIPE');
  });

  it('honours an explicit STRIPE provider', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1', {
      planId: 'plan-pro',
      billingProvider: 'STRIPE',
    } as never);

    expect(h.stripeService.createStripeSubscription).toHaveBeenCalled();
  });

  it('refuses a plan that is negotiated with sales, before touching Stripe', async () => {
    const h = buildHarness({
      plan: {
        ...PAID_PLAN,
        id: 'plan-enterprise',
        type: 'ENTERPRISE',
        name: 'Enterprise',
        amount: 1497,
        stripePriceId: 'price_enterprise',
      },
    });

    // Tem `stripePriceId` e passaria batido: a conta não tem assinatura, o
    // plano existe, e a próxima linha abriria uma cobrança de R$ 1.497 — que é
    // o piso de vitrine da landing, não o preço de contrato nenhum.
    await expect(
      h.useCase.execute('acc-1', { planId: 'plan-enterprise' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PLAN_REQUIRES_SALES_CONTACT' },
    });

    expect(h.stripeService.createStripeSubscription).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.save).not.toHaveBeenCalled();
  });

  it('does not call Stripe for a FREE plan', async () => {
    const h = buildHarness({
      plan: { ...PAID_PLAN, type: 'FREE', amount: 0, trialDays: 14 },
    });

    await h.useCase.execute('acc-1', { planId: 'plan-pro' } as never);

    expect(h.stripeService.createStripeSubscription).not.toHaveBeenCalled();
  });
});
