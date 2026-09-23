import { Subscription } from './subscription.entity';

/**
 * The scheduled-downgrade half of the Stripe plan-change rule.
 *
 * A downgrade must not touch `planId` — which is what drives entitlement — until the
 * period the customer already paid for has ended. These tests pin that boundary.
 */

function buildSubscription(overrides: Record<string, unknown> = {}) {
  return Subscription.restore({
    id: 'sub-1',
    accountId: 'acc-1',
    planId: 'plan-pro',
    billingStatus: 'ACTIVE',
    accessStatus: 'ALLOWED',
    automaticRenovation: true,
    isAnnual: false,
    startedAt: new Date('2026-07-25T00:00:00.000Z'),
    expiresAt: new Date('2026-08-25T00:00:00.000Z'),
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    ...overrides,
  } as never);
}

const PERIOD_END = new Date('2026-08-25T00:00:00.000Z');

describe('Subscription — scheduled downgrade', () => {
  it('records the target plan without changing the active one', async () => {
    const subscription = buildSubscription();

    subscription.scheduleDowngrade({
      planId: 'plan-starter',
      effectiveAt: PERIOD_END,
    });

    // Entitlement still reads plan-pro: the customer paid for it through PERIOD_END.
    expect(subscription.planId).toBe('plan-pro');
    expect(subscription.pendingPlanId).toBe('plan-starter');
    expect(subscription.pendingPlanEffectiveAt).toEqual(PERIOD_END);
  });

  it('does nothing when the effective date has not arrived', () => {
    const subscription = buildSubscription();
    subscription.scheduleDowngrade({
      planId: 'plan-starter',
      effectiveAt: PERIOD_END,
    });

    const changed = subscription.applyScheduledDowngradeIfDue(
      new Date('2026-08-24T23:59:59.000Z'),
    );

    expect(changed).toBe(false);
    expect(subscription.planId).toBe('plan-pro');
  });

  it('applies the plan once the date passes, and clears the schedule', () => {
    const subscription = buildSubscription();
    subscription.scheduleDowngrade({
      planId: 'plan-starter',
      effectiveAt: PERIOD_END,
    });

    const changed = subscription.applyScheduledDowngradeIfDue(
      new Date('2026-08-25T00:00:01.000Z'),
    );

    expect(changed).toBe(true);
    expect(subscription.planId).toBe('plan-starter');
    expect(subscription.pendingPlanId).toBeUndefined();
    expect(subscription.pendingPlanEffectiveAt).toBeUndefined();
  });

  // The webhook that applies this fires on every renewal, so a second call must not
  // keep re-applying an already-consumed schedule.
  it('is idempotent — a second call reports no change', () => {
    const subscription = buildSubscription();
    subscription.scheduleDowngrade({
      planId: 'plan-starter',
      effectiveAt: PERIOD_END,
    });
    subscription.applyScheduledDowngradeIfDue(new Date('2026-09-01'));

    expect(
      subscription.applyScheduledDowngradeIfDue(new Date('2026-09-02')),
    ).toBe(false);
    expect(subscription.planId).toBe('plan-starter');
  });

  it('reports no change when nothing was scheduled', () => {
    const subscription = buildSubscription();

    expect(subscription.applyScheduledDowngradeIfDue(new Date())).toBe(false);
  });

  it('drops the schedule when it is cleared', () => {
    const subscription = buildSubscription();
    subscription.scheduleDowngrade({
      planId: 'plan-starter',
      effectiveAt: PERIOD_END,
    });

    subscription.clearScheduledDowngrade();

    expect(subscription.pendingPlanId).toBeUndefined();
    expect(
      subscription.applyScheduledDowngradeIfDue(new Date('2026-09-01')),
    ).toBe(false);
    expect(subscription.planId).toBe('plan-pro');
  });
});
