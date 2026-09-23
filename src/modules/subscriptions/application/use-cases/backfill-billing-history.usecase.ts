import { Injectable, Logger } from '@nestjs/common';
import { Invoice } from 'src/modules/invoices/domain/entities';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { Payment } from 'src/modules/subscriptions/domain/entities';
import { PaymentsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';

export type BackfillTarget = {
  id: string;
  accountId: string;
  planId: string;
  billingProvider?: 'STRIPE' | null;
  externalSubscriptionId?: string | null;
};

/**
 * Recovers billing history that a dropped or permanently-failed webhook never
 * persisted.
 *
 * Subscription *status* already self-heals through reconciliation, but the
 * Invoice/Payment ledger is only written by the webhook handler — so once a
 * provider exhausts its retries the paid invoice would be missing locally
 * forever. This pass only *creates* records that are absent; it never mutates
 * history that already exists, which keeps it safe to run on every cycle.
 */
@Injectable()
export class BackfillBillingHistoryUseCase {
  private readonly logger = new Logger(BackfillBillingHistoryUseCase.name);

  constructor(
    private readonly invoicesRepository: InvoicesRepositoryInterface,
    private readonly paymentsRepository: PaymentsRepositoryInterface,
    private readonly stripeService: StripeService,
  ) {}

  async execute(subscription: BackfillTarget): Promise<{ created: number }> {
    // Only Stripe exposes a listable invoice history through the current
    // gateway surface. Mercado Pago recovery relies on the (now fixed) webhook
    // retry until an authorized-payment search is added to the gateway port.
    if (
      subscription.billingProvider !== 'STRIPE' ||
      !subscription.externalSubscriptionId
    ) {
      return { created: 0 };
    }

    const remoteInvoices = await this.stripeService.listSubscriptionInvoices(
      subscription.externalSubscriptionId,
    );

    let created = 0;

    for (const remote of remoteInvoices) {
      if (remote.status !== 'PAID') continue;

      const existing = await this.invoicesRepository.findByExternalInvoiceId(
        remote.externalInvoiceId,
      );
      if (existing) continue;

      const invoice = Invoice.create({
        accountId: subscription.accountId,
        subscriptionId: subscription.id,
        planId: subscription.planId,
        provider: 'STRIPE',
        number: this.generateInvoiceNumber(),
        amount: remote.amount,
        currency: remote.currency,
        periodStart: remote.periodStart,
        periodEnd: remote.periodEnd,
        externalInvoiceId: remote.externalInvoiceId,
      });
      invoice.updateStatus('PAID');
      await this.invoicesRepository.save(invoice);

      const payment = Payment.create({
        accountId: subscription.accountId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        provider: 'STRIPE',
        amount: remote.amount,
        currency: remote.currency,
        externalReference: `PAY-${invoice.id}`,
      });
      payment.updateFromProvider({
        status: 'APPROVED',
        externalPaymentId: remote.externalPaymentId,
        paymentMethod: 'CREDIT_CARD',
        paidAt: remote.paidAt ?? remote.periodEnd,
      });
      await this.paymentsRepository.save(payment);

      created += 1;
      // Warn, not log: reaching this branch means a webhook was permanently
      // lost and is worth investigating.
      this.logger.warn(
        `Backfilled missing paid invoice ${remote.externalInvoiceId} for subscription=${subscription.id}`,
      );
    }

    return { created };
  }

  private generateInvoiceNumber(): string {
    return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }
}
