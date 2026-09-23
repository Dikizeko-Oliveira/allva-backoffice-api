import { SyncSubscriptionBillingCardUseCase } from './sync-subscription-billing-card.usecase';

const STRIPE_CARD = {
  externalCardId: 'pm_checkout',
  externalCustomerId: 'cus_1',
  brand: 'visa',
  lastFourDigits: '4242',
  expirationMonth: 11,
  expirationYear: 2029,
  paymentMethod: 'CREDIT_CARD' as const,
};

function buildSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-local-1',
    accountId: 'acc-1',
    billingProvider: 'STRIPE',
    externalSubscriptionId: 'sub_stripe_1',
    billingCardId: undefined as string | undefined,
    assignBillingCard: jest.fn(function (this: any, id?: string) {
      this.billingCardId = id;
    }),
    ...overrides,
  };
}

function buildHarness({
  subscription = buildSubscription(),
  stripeCard = STRIPE_CARD as Record<string, unknown> | null,
  existingCard = null as Record<string, unknown> | null,
} = {}) {
  const subscriptionsRepository = {
    update: jest.fn().mockResolvedValue(undefined),
  };
  const billingCardsRepository = {
    findByExternalCardId: jest.fn().mockResolvedValue(existingCard),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    clearDefaultForAccount: jest.fn().mockResolvedValue(undefined),
  };
  const stripeService = {
    getSubscriptionDefaultCard: jest.fn().mockResolvedValue(stripeCard),
  };

  const useCase = new SyncSubscriptionBillingCardUseCase(
    subscriptionsRepository as never,
    billingCardsRepository as never,
    stripeService as never,
  );

  // The "no card at Stripe" branch logs, and that branch is under test here.
  const logger = (useCase as any).logger;
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined);
  }

  return {
    useCase,
    subscriptionsRepository,
    billingCardsRepository,
    stripeService,
    subscription,
  };
}

describe('SyncSubscriptionBillingCardUseCase', () => {
  it('records the checkout card that only ever existed at Stripe', async () => {
    const h = buildHarness();

    const card = await h.useCase.execute(h.subscription as never);

    expect(card?.lastFourDigits).toBe('4242');
    expect(card?.expirationMonth).toBe(11);
    expect(card?.expirationYear).toBe(2029);
    expect(card?.isDefault).toBe(true);
    expect(h.billingCardsRepository.save).toHaveBeenCalledTimes(1);
  });

  it('points the subscription at the card it just recorded', async () => {
    const h = buildHarness();

    const card = await h.useCase.execute(h.subscription as never);

    expect(h.subscription.assignBillingCard).toHaveBeenCalledWith(card?.id);
    expect(h.subscriptionsRepository.update).toHaveBeenCalledWith(
      h.subscription,
    );
  });

  it('refreshes an existing row instead of inserting a duplicate', async () => {
    const existing = {
      id: 'card-1',
      syncFromProvider: jest.fn(),
    };
    const h = buildHarness({ existingCard: existing });

    await h.useCase.execute(h.subscription as never);

    expect(h.billingCardsRepository.save).not.toHaveBeenCalled();
    expect(existing.syncFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ lastFourDigits: '4242', isDefault: true }),
    );
    expect(h.billingCardsRepository.update).toHaveBeenCalledWith(existing);
  });

  it('leaves the subscription untouched when it is already on that card', async () => {
    const existing = { id: 'card-1', syncFromProvider: jest.fn() };
    const h = buildHarness({
      existingCard: existing,
      subscription: buildSubscription({ billingCardId: 'card-1' }),
    });

    await h.useCase.execute(h.subscription as never);

    expect(h.subscription.assignBillingCard).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });

  it('writes nothing when Stripe reports no card on the subscription', async () => {
    const h = buildHarness({ stripeCard: null });

    await expect(
      h.useCase.execute(h.subscription as never),
    ).resolves.toBeNull();

    expect(h.billingCardsRepository.save).not.toHaveBeenCalled();
    expect(
      h.billingCardsRepository.clearDefaultForAccount,
    ).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });

  it('does not call Stripe for a subscription that has no Stripe counterpart', async () => {
    const h = buildHarness({
      subscription: buildSubscription({ externalSubscriptionId: undefined }),
    });

    await expect(
      h.useCase.execute(h.subscription as never),
    ).resolves.toBeNull();

    expect(h.stripeService.getSubscriptionDefaultCard).not.toHaveBeenCalled();
  });
});
