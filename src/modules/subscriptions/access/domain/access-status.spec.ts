import { BillingStatus, mapBillingToAccess } from './access-status';

describe('mapBillingToAccess', () => {
  it('returns BLOCKED when the billing status is missing', () => {
    expect(mapBillingToAccess(null)).toBe('BLOCKED');
    expect(mapBillingToAccess(undefined)).toBe('BLOCKED');
  });

  it('grants full access for ACTIVE and TRIALING', () => {
    expect(mapBillingToAccess('ACTIVE')).toBe('ALLOWED');
    expect(mapBillingToAccess('TRIALING')).toBe('ALLOWED');
  });

  it('puts PAST_DUE into the grace period', () => {
    expect(mapBillingToAccess('PAST_DUE')).toBe('GRACE_PERIOD');
  });

  it('maps pending states to PENDING_ACTIVATION', () => {
    expect(mapBillingToAccess('PENDING_PAYMENT')).toBe('PENDING_ACTIVATION');
    expect(mapBillingToAccess('PENDING_ACTIVATION')).toBe('PENDING_ACTIVATION');
  });

  it('requires payment for terminal / unpaid states', () => {
    const paymentRequired: BillingStatus[] = [
      'CANCELED',
      'EXPIRED',
      'UNPAID',
      'INCOMPLETE',
      'PAUSED',
    ];
    for (const status of paymentRequired) {
      expect(mapBillingToAccess(status)).toBe('PAYMENT_REQUIRED');
    }
  });
});
