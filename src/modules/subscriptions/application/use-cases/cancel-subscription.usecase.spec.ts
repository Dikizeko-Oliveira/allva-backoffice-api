import { BadRequestException } from '@nestjs/common';
import { CancelSubscriptionUseCase } from './cancel-subscription.usecase';

function buildHarness(
  subscription: Record<string, unknown> | null = {
    id: 'sub-1',
    status: 'ACTIVE',
    billingProvider: 'STRIPE',
    externalSubscriptionId: 'sub_stripe_123',
    cancel: jest.fn(),
  },
) {
  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(subscription),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const stripeService = {
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new CancelSubscriptionUseCase(
    subscriptionsRepository as never,
    stripeService as never,
    auditLog as never,
  );

  return {
    useCase,
    subscriptionsRepository,
    stripeService,
    auditLog,
    subscription,
  };
}

describe('CancelSubscriptionUseCase', () => {
  /**
   * THE M-3 REGRESSION. Before the fix this use case handled Mercado Pago and then
   * fell off the end of the method for Stripe, on the assumption the caller had
   * already cancelled at the provider. `DELETE /subscriptions/cancel` called it
   * directly — so a Stripe subscriber got HTTP 200, nothing was cancelled anywhere,
   * and the card kept being charged.
   */
  it('cancels at Stripe when the subscription lives there', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1');

    expect(h.stripeService.cancelSubscription).toHaveBeenCalledWith({
      externalRef: 'sub_stripe_123',
    });
  });

  it('does not flip local state for Stripe — the period is still paid for', async () => {
    const h = buildHarness();

    await h.useCase.execute('acc-1');

    // Stripe cancels at period end; `customer.subscription.deleted` closes the
    // local record later. Cancelling here would revoke paid-for access early.
    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });

  it('closes a subscription that never reached a provider', async () => {
    const cancel = jest.fn();
    const h = buildHarness({
      id: 'sub-1',
      status: 'TRIALING',
      billingProvider: 'STRIPE',
      externalSubscriptionId: null,
      cancel,
    });

    await h.useCase.execute('acc-1');

    expect(cancel).toHaveBeenCalled();
    expect(h.stripeService.cancelSubscription).not.toHaveBeenCalled();
  });

  it('rejects when the account has no subscription', async () => {
    const h = buildHarness(null);

    await expect(h.useCase.execute('acc-1')).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_NOT_FOUND' },
    });
  });

  it('rejects an already-cancelled subscription instead of calling the provider twice', async () => {
    const h = buildHarness({
      id: 'sub-1',
      status: 'CANCELED',
      billingProvider: 'STRIPE',
      externalSubscriptionId: 'sub_stripe_123',
      cancel: jest.fn(),
    });

    await expect(h.useCase.execute('acc-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(h.stripeService.cancelSubscription).not.toHaveBeenCalled();
  });

  describe('audit trail', () => {
    it.each([
      ['a Stripe subscription', 'sub_stripe_123', 'stripe'],
      ['a subscription that never reached Stripe', null, 'local_only'],
    ])('records the cancellation of %s', async (_name, externalId, via) => {
      const h = buildHarness({
        id: 'sub-1',
        status: 'ACTIVE',
        billingProvider: 'STRIPE',
        externalSubscriptionId: externalId,
        cancel: jest.fn(),
      });

      await h.useCase.execute('acc-1');

      expect(h.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'subscription.canceled',
          entityId: 'sub-1',
          actorId: 'acc-1',
          metadata: { via },
        }),
      );
    });

    it('does not record anything when the cancellation was rejected', async () => {
      const h = buildHarness(null);

      await expect(h.useCase.execute('acc-1')).rejects.toThrow();
      expect(h.auditLog.record).not.toHaveBeenCalled();
    });
  });
});
