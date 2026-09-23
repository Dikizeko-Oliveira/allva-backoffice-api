import { NotFoundException } from '@nestjs/common';
import { GetSubscriptionBillingCardUseCase } from './get-subscription-billing-card.usecase';

function buildHarness({
  subscription = {
    id: 'sub-local-1',
    accountId: 'acc-1',
    billingCardId: undefined as string | undefined,
  } as Record<string, unknown> | null,
  localCard = null as Record<string, unknown> | null,
  syncedCard = { id: 'card-recovered' } as Record<string, unknown> | null,
  syncFails = false,
} = {}) {
  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(subscription),
  };
  const billingCardsRepository = {
    findById: jest.fn().mockResolvedValue(localCard),
  };
  const syncSubscriptionBillingCard = {
    execute: syncFails
      ? jest.fn().mockRejectedValue(new Error('Stripe unreachable'))
      : jest.fn().mockResolvedValue(syncedCard),
  };

  const useCase = new GetSubscriptionBillingCardUseCase(
    subscriptionsRepository as never,
    billingCardsRepository as never,
    syncSubscriptionBillingCard as never,
  );

  // The Stripe-failure branch logs, and that branch is under test here.
  const logger = (useCase as any).logger;
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  return {
    useCase,
    subscriptionsRepository,
    billingCardsRepository,
    syncSubscriptionBillingCard,
  };
}

describe('GetSubscriptionBillingCardUseCase', () => {
  it('returns the card already on file without calling Stripe', async () => {
    const localCard = { id: 'card-1' };
    const h = buildHarness({
      subscription: { id: 'sub-local-1', billingCardId: 'card-1' },
      localCard,
    });

    await expect(h.useCase.execute('acc-1')).resolves.toBe(localCard);
    expect(h.syncSubscriptionBillingCard.execute).not.toHaveBeenCalled();
  });

  it('recovers the card from Stripe when checkout never wrote one locally', async () => {
    const h = buildHarness();

    const card = await h.useCase.execute('acc-1');

    expect(card).toEqual({ id: 'card-recovered' });
    expect(h.syncSubscriptionBillingCard.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers when billingCardId points at a row that is gone', async () => {
    const h = buildHarness({
      subscription: { id: 'sub-local-1', billingCardId: 'card-missing' },
      localCard: null,
    });

    await expect(h.useCase.execute('acc-1')).resolves.toEqual({
      id: 'card-recovered',
    });
  });

  it('answers "no card" instead of failing when Stripe is unreachable', async () => {
    const h = buildHarness({ syncFails: true });

    await expect(h.useCase.execute('acc-1')).resolves.toBeNull();
  });

  it('still rejects an account with no subscription at all', async () => {
    const h = buildHarness({ subscription: null });

    await expect(h.useCase.execute('acc-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
