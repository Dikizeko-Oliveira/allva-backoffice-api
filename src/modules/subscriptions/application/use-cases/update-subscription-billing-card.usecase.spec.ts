import { UpdateSubscriptionBillingCardUseCase } from './update-subscription-billing-card.usecase';

const STRIPE_CARD = {
  externalCardId: 'pm_new',
  brand: 'visa',
  lastFourDigits: '4242',
  expirationMonth: 12,
  expirationYear: 2030,
};

function buildHarness({
  subscription = {
    id: 'sub-1',
    externalSubscriptionId: 'sub_stripe_1',
    assignBillingCard: jest.fn(),
  } as Record<string, unknown> | null,
  account = { id: 'acc-1', stripeCustomerId: 'cus_1' } as Record<
    string,
    unknown
  > | null,
  existingCard = null as Record<string, unknown> | null,
} = {}) {
  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(subscription),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const billingCardsRepository = {
    findByExternalCardId: jest.fn().mockResolvedValue(existingCard),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    clearDefaultForAccount: jest.fn().mockResolvedValue(undefined),
  };
  const accountsRepository = {
    findById: jest.fn().mockResolvedValue(account),
  };
  const stripeService = {
    setSubscriptionPaymentMethod: jest.fn().mockResolvedValue(STRIPE_CARD),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new UpdateSubscriptionBillingCardUseCase(
    subscriptionsRepository as never,
    billingCardsRepository as never,
    accountsRepository as never,
    stripeService as never,
    auditLog as never,
  );

  return {
    useCase,
    subscriptionsRepository,
    billingCardsRepository,
    stripeService,
    auditLog,
    subscription,
  };
}

describe('UpdateSubscriptionBillingCardUseCase (Stripe)', () => {
  it('makes the payment method the subscription default at Stripe', async () => {
    const h = buildHarness();

    await h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' });

    expect(h.stripeService.setSubscriptionPaymentMethod).toHaveBeenCalledWith({
      externalRef: 'sub_stripe_1',
      stripeCustomerId: 'cus_1',
      paymentMethodId: 'pm_new',
    });
  });

  it('stores the card details Stripe reported, not what the client claimed', async () => {
    const h = buildHarness();

    const card = await h.useCase.execute({
      accountId: 'acc-1',
      paymentMethodId: 'pm_new',
    });

    expect(card.lastFourDigits).toBe('4242');
    expect(card.brand).toBe('visa');
    expect(h.billingCardsRepository.save).toHaveBeenCalled();
  });

  // Exactly one default per account, or the panel shows a card Stripe is not using.
  it('clears the previous default before saving the new card', async () => {
    const h = buildHarness();

    await h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' });

    expect(
      h.billingCardsRepository.clearDefaultForAccount,
    ).toHaveBeenCalledWith('acc-1', 'STRIPE');
  });

  it('links the card to the subscription', async () => {
    const h = buildHarness();

    await h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' });

    expect(h.subscription!.assignBillingCard).toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).toHaveBeenCalled();
  });

  it('reuses the local row when the same payment method is sent again', async () => {
    const existingCard = {
      id: 'card-1',
      brand: 'visa',
      syncFromProvider: jest.fn(),
    };
    const h = buildHarness({ existingCard });

    const card = await h.useCase.execute({
      accountId: 'acc-1',
      paymentMethodId: 'pm_new',
    });

    // Repeating the operation must not accumulate duplicate cards.
    expect(card).toBe(existingCard);
    expect(h.billingCardsRepository.save).not.toHaveBeenCalled();
    expect(h.billingCardsRepository.update).toHaveBeenCalled();
  });

  it('leaves the reused row as the default, after the clear-default sweep', async () => {
    // The sweep sets every card of the account to `isDefault: false`. Writing the
    // reused row back without re-marking it left the account with no default card —
    // the customer re-selected the card they were already on and it stopped being
    // the one on file.
    const existingCard = { id: 'card-1', syncFromProvider: jest.fn() };
    const h = buildHarness({ existingCard });

    await h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' });

    expect(existingCard.syncFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true, lastFourDigits: '4242' }),
    );
    expect(
      h.billingCardsRepository.clearDefaultForAccount.mock
        .invocationCallOrder[0],
    ).toBeLessThan(existingCard.syncFromProvider.mock.invocationCallOrder[0]);
  });

  describe('rejections', () => {
    it('refuses when the account has no subscription', async () => {
      const h = buildHarness({ subscription: null });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' }),
      ).rejects.toMatchObject({ response: { code: 'SUBSCRIPTION_NOT_FOUND' } });
    });

    it('refuses a subscription with no Stripe counterpart', async () => {
      const h = buildHarness({
        subscription: {
          id: 'sub-1',
          externalSubscriptionId: null,
          assignBillingCard: jest.fn(),
        },
      });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' }),
      ).rejects.toMatchObject({
        response: { code: 'SUBSCRIPTION_NOT_ON_PROVIDER' },
      });
    });

    it('refuses an account with no Stripe customer to attach to', async () => {
      const h = buildHarness({
        account: { id: 'acc-1', stripeCustomerId: null },
      });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_new' }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_CUSTOMER_NOT_FOUND' },
      });
      expect(
        h.stripeService.setSubscriptionPaymentMethod,
      ).not.toHaveBeenCalled();
    });

    it('does not persist anything when Stripe rejects the card', async () => {
      const h = buildHarness();
      h.stripeService.setSubscriptionPaymentMethod.mockRejectedValue(
        new Error('card declined'),
      );

      await expect(
        h.useCase.execute({ accountId: 'acc-1', paymentMethodId: 'pm_bad' }),
      ).rejects.toThrow();

      // The local card must never claim a payment method Stripe refused.
      expect(h.billingCardsRepository.save).not.toHaveBeenCalled();
      expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    it('records the change with only the card identifiers', async () => {
      const h = buildHarness();

      await h.useCase.execute({
        accountId: 'acc-1',
        paymentMethodId: 'pm_new',
      });

      expect(h.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'subscription.payment_method_changed',
          entityId: 'sub-1',
          actorId: 'acc-1',
          metadata: { brand: 'visa', last4: '4242' },
        }),
      );
    });
  });
});
