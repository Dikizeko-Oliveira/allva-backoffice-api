import { AccessStatus } from './access-status';

export const PRODUCT_ACCESS_ALLOWED: ReadonlyArray<AccessStatus> = [
  'ALLOWED',
  'GRACE_PERIOD',
];

export const SUBSCRIPTION_RECOVERY_ALLOWED: ReadonlyArray<AccessStatus> = [
  'GRACE_PERIOD',
  'PAYMENT_REQUIRED',
  'PENDING_ACTIVATION',
  'BLOCKED',
];

export const BILLING_PAGE_ALLOWED: ReadonlyArray<AccessStatus> = [
  'ALLOWED',
  'GRACE_PERIOD',
];

export const SUBSCRIPTIONS_PAGE_ALLOWED: ReadonlyArray<AccessStatus> = [
  'GRACE_PERIOD',
  'PAYMENT_REQUIRED',
  'PENDING_ACTIVATION',
  'BLOCKED',
];

export function isAccessAllowed(
  status: AccessStatus,
  allowed: ReadonlyArray<AccessStatus>,
): boolean {
  return allowed.includes(status);
}
