import {
  InvoiceStatus,
  canTransitionInvoiceStatus,
} from './invoice-status-policy';

const ALL: InvoiceStatus[] = [
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELED',
  'EXPIRED',
];

describe('canTransitionInvoiceStatus', () => {
  it.each(ALL)(
    'treats %s -> itself as legal (webhook redelivery)',
    (status) => {
      // Stripe redelivers `invoice.paid`, and the webhook use case re-applies PAID
      // to an invoice it already settled. Rejecting the repeat would turn a
      // duplicate delivery into an error.
      expect(canTransitionInvoiceStatus(status, status)).toBe(true);
    },
  );

  it('lets a pending invoice reach every outcome', () => {
    expect(canTransitionInvoiceStatus('PENDING', 'PAID')).toBe(true);
    expect(canTransitionInvoiceStatus('PENDING', 'FAILED')).toBe(true);
    expect(canTransitionInvoiceStatus('PENDING', 'CANCELED')).toBe(true);
    expect(canTransitionInvoiceStatus('PENDING', 'EXPIRED')).toBe(true);
  });

  it('lets a failed charge settle on retry', () => {
    expect(canTransitionInvoiceStatus('FAILED', 'PAID')).toBe(true);
  });

  it.each(['PAID', 'CANCELED', 'EXPIRED'] as const)(
    'makes %s terminal',
    (terminal) => {
      const others = ALL.filter((status) => status !== terminal);

      for (const target of others) {
        expect(canTransitionInvoiceStatus(terminal, target)).toBe(false);
      }
    },
  );

  it('never walks a settled invoice back to pending', () => {
    // The specific move that the customer-writable endpoint used to allow in
    // reverse: undoing a payment is a correction, not a status update.
    expect(canTransitionInvoiceStatus('PAID', 'PENDING')).toBe(false);
  });
});
