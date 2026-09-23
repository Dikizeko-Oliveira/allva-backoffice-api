import { StripeNormalizedInvoice } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import {
  BackfillBillingHistoryUseCase,
  BackfillTarget,
} from './backfill-billing-history.usecase';

function paidInvoice(
  overrides: Partial<StripeNormalizedInvoice> = {},
): StripeNormalizedInvoice {
  return {
    externalInvoiceId: 'in_1',
    externalPaymentId: 'ch_1',
    status: 'PAID',
    amount: 50,
    currency: 'BRL',
    periodStart: new Date('2026-01-01T00:00:00Z'),
    periodEnd: new Date('2026-02-01T00:00:00Z'),
    paidAt: new Date('2026-01-01T12:00:00Z'),
    ...overrides,
  };
}

function buildHarness(remoteInvoices: StripeNormalizedInvoice[]) {
  const invoicesRepository = {
    findByExternalInvoiceId: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const paymentsRepository = { save: jest.fn().mockResolvedValue(undefined) };
  const stripeService = {
    listSubscriptionInvoices: jest.fn().mockResolvedValue(remoteInvoices),
  };

  const useCase = new BackfillBillingHistoryUseCase(
    invoicesRepository as any,
    paymentsRepository as any,
    stripeService as any,
  );

  return { useCase, invoicesRepository, paymentsRepository, stripeService };
}

const stripeSubscription: BackfillTarget = {
  id: 'sub-local-1',
  accountId: 'acc-1',
  planId: 'plan-1',
  billingProvider: 'STRIPE',
  externalSubscriptionId: 'sub_ext_1',
};

describe('BackfillBillingHistoryUseCase', () => {
  it('creates the missing invoice and payment for a paid remote invoice', async () => {
    const h = buildHarness([paidInvoice()]);

    await expect(h.useCase.execute(stripeSubscription)).resolves.toEqual({
      created: 1,
    });
    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
    expect(h.paymentsRepository.save).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate history that already exists locally', async () => {
    const h = buildHarness([paidInvoice()]);
    h.invoicesRepository.findByExternalInvoiceId.mockResolvedValue({
      id: 'existing-invoice',
    });

    await expect(h.useCase.execute(stripeSubscription)).resolves.toEqual({
      created: 0,
    });
    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
    expect(h.paymentsRepository.save).not.toHaveBeenCalled();
  });

  it('ignores remote invoices that are not paid', async () => {
    const h = buildHarness([
      paidInvoice({ externalInvoiceId: 'in_2', status: 'PENDING' }),
      paidInvoice({ externalInvoiceId: 'in_3', status: 'FAILED' }),
    ]);

    await expect(h.useCase.execute(stripeSubscription)).resolves.toEqual({
      created: 0,
    });
    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
  });

  // FREE plans never reach a provider, so there is no remote history to backfill.
  it('is a no-op for a subscription with no billing provider', async () => {
    const h = buildHarness([paidInvoice()]);

    await expect(
      h.useCase.execute({
        ...stripeSubscription,
        billingProvider: null,
      }),
    ).resolves.toEqual({ created: 0 });
    expect(h.stripeService.listSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no external subscription id', async () => {
    const h = buildHarness([paidInvoice()]);

    await expect(
      h.useCase.execute({
        ...stripeSubscription,
        externalSubscriptionId: null,
      }),
    ).resolves.toEqual({ created: 0 });
    expect(h.stripeService.listSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it('backfills every missing paid invoice in one pass', async () => {
    const h = buildHarness([
      paidInvoice({ externalInvoiceId: 'in_1' }),
      paidInvoice({ externalInvoiceId: 'in_2' }),
      paidInvoice({ externalInvoiceId: 'in_3', status: 'PENDING' }),
    ]);

    await expect(h.useCase.execute(stripeSubscription)).resolves.toEqual({
      created: 2,
    });
    expect(h.paymentsRepository.save).toHaveBeenCalledTimes(2);
  });
});
