import { ChangeSubscriptionUseCase } from './change-subscription.usecase';

/**
 * Datas relativas ao agora, e não fixas.
 *
 * As constantes eram `2026-08-25` e `2026-08-20` - futuro quando o teste foi
 * escrito, passado quando o calendário passou por cima delas. Como o caso de uso
 * agora recusa agendar uma queda para trás, um fixture vencido faria o teste
 * falhar por envelhecer, não por regressão.
 */
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const PERIOD_END = daysFromNow(22);
const LOCAL_EXPIRY = daysFromNow(17);

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-starter',
    name: 'Starter',
    type: 'STARTER',
    amount: 49.9,
    stripePriceId: 'price_starter',
    ...overrides,
  };
}

const STARTER = plan();
const PRO = plan({
  id: 'plan-pro',
  name: 'Pro',
  type: 'PRO',
  amount: 149.9,
  stripePriceId: 'price_pro',
});

/** A subscription sitting on `planId`, with the entity methods the use case calls. */
function subscriptionOn(planId: string): Record<string, unknown> {
  return {
    id: 'sub-1',
    planId,
    externalSubscriptionId: 'sub_stripe_1',
    expiresAt: LOCAL_EXPIRY,
    scheduleDowngrade: jest.fn(),
    clearScheduledDowngrade: jest.fn(),
    activatePaidPlan: jest.fn(),
  };
}

function buildHarness({
  current = STARTER,
  target = PRO,
  subscription,
}: {
  current?: unknown;
  target?: unknown;
  /** Omit to get a subscription already on `current` — the realistic setup. */
  subscription?: Record<string, unknown> | null;
} = {}) {
  // `undefined` means "derive it"; `null` means "no subscription at all".
  const activeSubscription =
    subscription === undefined
      ? subscriptionOn((current as { id: string }).id)
      : subscription;
  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue(activeSubscription),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const plansRepository = {
    findById: jest.fn((id: string) => {
      if (current && (current as any).id === id)
        return Promise.resolve(current);
      if (target && (target as any).id === id) return Promise.resolve(target);
      return Promise.resolve(null);
    }),
  };

  const stripeService = {
    changeSubscriptionPlan: jest
      .fn()
      .mockResolvedValue({ status: 'ACTIVE', currentPeriodEnd: PERIOD_END }),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new ChangeSubscriptionUseCase(
    subscriptionsRepository as never,
    plansRepository as never,
    stripeService as never,
    auditLog as never,
    {
      scheduleForAccount: jest.fn().mockResolvedValue(undefined),
      upgradeForAccount: jest.fn().mockResolvedValue(undefined),
    } as never,
  );

  return {
    useCase,
    subscriptionsRepository,
    stripeService,
    auditLog,
    subscription: activeSubscription,
  };
}

describe('ChangeSubscriptionUseCase (Stripe)', () => {
  describe('upgrade', () => {
    it('moves the Stripe subscription to the new price, prorated', async () => {
      const h = buildHarness();

      await h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' });

      expect(h.stripeService.changeSubscriptionPlan).toHaveBeenCalledWith({
        externalRef: 'sub_stripe_1',
        newStripePriceId: 'price_pro',
        prorate: true,
      });
    });

    it('applies the new plan immediately', async () => {
      const h = buildHarness();

      const result = await h.useCase.execute({
        accountId: 'acc-1',
        planId: 'plan-pro',
      });

      expect(result).toEqual({ planId: 'plan-pro', effect: 'IMMEDIATE' });
      expect(h.subscription!.activatePaidPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan-pro',
          billingProvider: 'STRIPE',
        }),
      );
      expect(h.subscriptionsRepository.update).toHaveBeenCalled();
    });

    // Someone who downgrades and then changes their mind must not be dropped to the
    // cheaper plan later by a schedule nobody cancelled.
    it('cancels any scheduled downgrade', async () => {
      const h = buildHarness();

      await h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' });

      expect(h.subscription!.clearScheduledDowngrade).toHaveBeenCalled();
      expect(h.subscription!.scheduleDowngrade).not.toHaveBeenCalled();
    });
  });

  describe('downgrade', () => {
    function downgradeHarness() {
      return buildHarness({ current: PRO, target: STARTER });
    }

    it('tells Stripe not to prorate', async () => {
      const h = downgradeHarness();

      await h.useCase.execute({ accountId: 'acc-1', planId: 'plan-starter' });

      expect(h.stripeService.changeSubscriptionPlan).toHaveBeenCalledWith(
        expect.objectContaining({ prorate: false }),
      );
    });

    /**
     * The core of the product rule: the customer paid for the current period, so the
     * cheaper plan starts only when that period ends. Changing `planId` now would
     * take away access already bought.
     */
    it('schedules the plan change for the end of the paid period', async () => {
      const h = downgradeHarness();

      const result = await h.useCase.execute({
        accountId: 'acc-1',
        planId: 'plan-starter',
      });

      expect(h.subscription!.scheduleDowngrade).toHaveBeenCalledWith({
        planId: 'plan-starter',
        effectiveAt: PERIOD_END,
      });
      expect(h.subscription!.activatePaidPlan).not.toHaveBeenCalled();
      expect(result).toEqual({
        planId: 'plan-starter',
        effect: 'AT_PERIOD_END',
        effectiveAt: PERIOD_END,
      });
    });

    it('falls back to the local expiry when Stripe returns no period end', async () => {
      const h = downgradeHarness();
      h.stripeService.changeSubscriptionPlan.mockResolvedValue({
        status: 'ACTIVE',
      });

      await h.useCase.execute({ accountId: 'acc-1', planId: 'plan-starter' });

      expect(h.subscription!.scheduleDowngrade).toHaveBeenCalledWith({
        planId: 'plan-starter',
        effectiveAt: LOCAL_EXPIRY,
      });
    });

    it('never schedules the downgrade in the past', async () => {
      /**
       * A queda agendada para trás é aplicada no primeiro webhook seguinte, e o
       * cliente perde na hora o plano que pagou até o fim do mês. Aconteceu de
       * verdade: o fim de período vinha do `billing_cycle_anchor`, que é o
       * início do ciclo. Corrigida a leitura, esta guarda garante que a próxima
       * data ruim do provedor custe um agendamento conservador, não o acesso.
       */
      const h = downgradeHarness();
      (h.subscription as unknown as { expiresAt: Date }).expiresAt =
        daysFromNow(-30);
      h.stripeService.changeSubscriptionPlan.mockResolvedValue({
        status: 'ACTIVE',
        currentPeriodEnd: daysFromNow(-3),
      });

      await h.useCase.execute({ accountId: 'acc-1', planId: 'plan-starter' });

      const scheduleDowngrade = h.subscription!
        .scheduleDowngrade as jest.Mock;
      const [{ effectiveAt }] = scheduleDowngrade.mock.calls[0] as [
        { effectiveAt: Date },
      ];

      expect(effectiveAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('rejections', () => {
    it('refuses when the account has no subscription', async () => {
      const h = buildHarness({ subscription: null });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' }),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_SUBSCRIPTION_STATE' },
      });
    });

    it('refuses an unknown target plan', async () => {
      const h = buildHarness();

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-ghost' }),
      ).rejects.toMatchObject({ response: { code: 'PLAN_NOT_FOUND' } });
    });

    it('refuses changing to the plan already active', async () => {
      const h = buildHarness();

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-starter' }),
      ).rejects.toMatchObject({ response: { code: 'PLAN_ALREADY_ACTIVE' } });
    });

    it('refuses a move to FREE through this endpoint', async () => {
      const h = buildHarness({
        target: plan({ id: 'plan-free', type: 'FREE', amount: 0 }),
      });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-free' }),
      ).rejects.toMatchObject({
        response: { code: 'FREE_CHANGE_NOT_ALLOWED' },
      });
    });

    it('refuses a move to a plan that is negotiated with sales', async () => {
      const h = buildHarness({
        target: plan({
          id: 'plan-enterprise',
          type: 'ENTERPRISE',
          amount: 1497,
          stripePriceId: 'price_enterprise',
        }),
      });

      // Tem preço na Stripe e é um upgrade legítimo pela aritmética — o que o
      // impede é o packaging: R$ 1.497 é o piso de vitrine, não o contrato.
      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-enterprise' }),
      ).rejects.toMatchObject({
        response: { code: 'PLAN_REQUIRES_SALES_CONTACT' },
      });
      expect(h.stripeService.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a target plan with no Stripe price configured', async () => {
      const h = buildHarness({
        target: plan({ id: 'plan-pro', amount: 149.9, stripePriceId: null }),
      });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_PRICE_NOT_CONFIGURED' },
      });
      expect(h.stripeService.changeSubscriptionPlan).not.toHaveBeenCalled();
    });

    it('refuses a subscription that has no Stripe counterpart', async () => {
      const h = buildHarness({
        subscription: {
          id: 'sub-1',
          planId: 'plan-starter',
          externalSubscriptionId: null,
          expiresAt: new Date(),
          scheduleDowngrade: jest.fn(),
          clearScheduledDowngrade: jest.fn(),
          activatePaidPlan: jest.fn(),
        },
      });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' }),
      ).rejects.toMatchObject({
        response: { code: 'SUBSCRIPTION_NOT_ON_PROVIDER' },
      });
    });

    it('does not touch Stripe when a validation rejects first', async () => {
      const h = buildHarness({ subscription: null });

      await expect(
        h.useCase.execute({ accountId: 'acc-1', planId: 'plan-pro' }),
      ).rejects.toThrow();
      expect(h.stripeService.changeSubscriptionPlan).not.toHaveBeenCalled();
    });
  });

  describe('audit trail', () => {
    it.each([
      ['upgrade', 'plan-pro', STARTER, PRO, 'IMMEDIATE'],
      ['downgrade', 'plan-starter', PRO, STARTER, 'AT_PERIOD_END'],
    ])('records a %s', async (direction, planId, current, target, effect) => {
      const h = buildHarness({ current, target });

      await h.useCase.execute({ accountId: 'acc-1', planId });

      expect(h.auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'subscription.plan_changed',
          entityId: 'sub-1',
          actorId: 'acc-1',
          metadata: expect.objectContaining({ direction, effect, planId }),
        }),
      );
    });
  });
});
