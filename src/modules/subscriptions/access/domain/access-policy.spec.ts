import {
  BILLING_PAGE_ALLOWED,
  PRODUCT_ACCESS_ALLOWED,
  SUBSCRIPTIONS_PAGE_ALLOWED,
  isAccessAllowed,
} from './access-policy';

describe('isAccessAllowed', () => {
  it('allows product access only for ALLOWED and GRACE_PERIOD', () => {
    expect(isAccessAllowed('ALLOWED', PRODUCT_ACCESS_ALLOWED)).toBe(true);
    expect(isAccessAllowed('GRACE_PERIOD', PRODUCT_ACCESS_ALLOWED)).toBe(true);
    expect(isAccessAllowed('PAYMENT_REQUIRED', PRODUCT_ACCESS_ALLOWED)).toBe(
      false,
    );
    expect(isAccessAllowed('PENDING_ACTIVATION', PRODUCT_ACCESS_ALLOWED)).toBe(
      false,
    );
    expect(isAccessAllowed('BLOCKED', PRODUCT_ACCESS_ALLOWED)).toBe(false);
  });

  it('lets a blocked user still reach the subscriptions page to recover', () => {
    expect(isAccessAllowed('BLOCKED', SUBSCRIPTIONS_PAGE_ALLOWED)).toBe(true);
    expect(
      isAccessAllowed('PAYMENT_REQUIRED', SUBSCRIPTIONS_PAGE_ALLOWED),
    ).toBe(true);
    // An already-active user should not be routed to the subscriptions page.
    expect(isAccessAllowed('ALLOWED', SUBSCRIPTIONS_PAGE_ALLOWED)).toBe(false);
  });

  it('restricts the billing page to active / grace users', () => {
    expect(isAccessAllowed('ALLOWED', BILLING_PAGE_ALLOWED)).toBe(true);
    expect(isAccessAllowed('GRACE_PERIOD', BILLING_PAGE_ALLOWED)).toBe(true);
    expect(isAccessAllowed('BLOCKED', BILLING_PAGE_ALLOWED)).toBe(false);
  });
});
