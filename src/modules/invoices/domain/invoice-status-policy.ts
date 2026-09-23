/**
 * Lifecycle of a billing invoice.
 *
 * An invoice is a financial record, so the machine below is deliberately
 * one-way: `PAID`, `CANCELED` and `EXPIRED` are terminal. Undoing a settled
 * invoice is a correction, not a status update, and it does not have a path
 * today — inventing one silently here would let a bookkeeping mistake look
 * like a normal state change in the audit trail.
 */
export type InvoiceStatus =
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'CANCELED'
  | 'EXPIRED';

const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  PENDING: ['PAID', 'FAILED', 'CANCELED', 'EXPIRED'],
  // A failed charge can still be retried and settle, so FAILED is not terminal.
  FAILED: ['PAID', 'CANCELED', 'EXPIRED'],
  PAID: [],
  CANCELED: [],
  EXPIRED: [],
};

/**
 * Whether `to` is reachable from `from`.
 *
 * A transition to the current status is always allowed and is a no-op. That is
 * load-bearing rather than lenient: Stripe redelivers `invoice.paid`, and
 * `HandleStripeWebhookUseCase` re-applies `PAID` to an invoice it already
 * settled. Rejecting the repeat would turn a duplicate webhook into an error.
 */
export function canTransitionInvoiceStatus(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  if (from === to) return true;

  return ALLOWED_TRANSITIONS[from].includes(to);
}
