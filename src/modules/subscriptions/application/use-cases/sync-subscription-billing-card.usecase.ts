import { Injectable, Logger } from '@nestjs/common';
import {
  BillingCard,
  Subscription,
} from 'src/modules/subscriptions/domain/entities';
import {
  BillingCardsRepositoryInterface,
  SubscriptionsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';

/**
 * Brings the local `BillingCard` in line with the card Stripe charges.
 *
 * It exists because checkout never produced one. The client confirms the first
 * invoice's PaymentIntent straight with Stripe.js, so the card is only ever known
 * to Stripe; locally, `BillingCard` was written by exactly one path —
 * {@link UpdateSubscriptionBillingCardUseCase}, i.e. *changing* the payment method
 * after the fact. A subscriber who paid once and never touched the card again had
 * `subscription.billingCardId = null`, and `/billing/payment-method` answered
 * `{ paymentMethod: null }` — the screen read "Nenhum cartão cadastrado" to someone
 * who was being billed on a card every month.
 *
 * Two callers, deliberately:
 * - `invoice.paid` (write path), so an activating subscription records its card at
 *   the moment Stripe assigns it;
 * - `GET /billing/payment-method` (read repair), so subscriptions that were already
 *   paid for before this existed heal on the next page load instead of needing a
 *   webhook replay.
 */
@Injectable()
export class SyncSubscriptionBillingCardUseCase {
  private readonly logger = new Logger(SyncSubscriptionBillingCardUseCase.name);

  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly billingCardsRepository: BillingCardsRepositoryInterface,
    private readonly stripeService: StripeService,
  ) {}

  async execute(subscription: Subscription): Promise<BillingCard | null> {
    if (
      subscription.billingProvider !== 'STRIPE' ||
      !subscription.externalSubscriptionId
    ) {
      return null;
    }

    const details = await this.stripeService.getSubscriptionDefaultCard(
      subscription.externalSubscriptionId,
    );

    if (!details) {
      this.logger.debug(
        `No default card at Stripe for subscription ${subscription.externalSubscriptionId}`,
      );
      return null;
    }

    // Keyed on the Stripe payment method, so re-running this never accumulates
    // duplicate rows for the same card.
    const existing = await this.billingCardsRepository.findByExternalCardId(
      'STRIPE',
      details.externalCardId,
    );

    // Exactly one default per account: the card Stripe now charges.
    await this.billingCardsRepository.clearDefaultForAccount(
      subscription.accountId,
      'STRIPE',
    );

    if (existing) {
      // Refreshes brand/last4/expiry too: a card reissued under the same payment
      // method id (new expiry date) would otherwise keep showing the old one.
      existing.syncFromProvider({
        brand: details.brand,
        paymentMethod: details.paymentMethod,
        lastFourDigits: details.lastFourDigits,
        expirationMonth: details.expirationMonth,
        expirationYear: details.expirationYear,
        isDefault: true,
      });
      await this.billingCardsRepository.update(existing);
    }

    const card =
      existing ??
      BillingCard.create({
        accountId: subscription.accountId,
        provider: 'STRIPE',
        externalCustomerId: details.externalCustomerId,
        externalCardId: details.externalCardId,
        brand: details.brand,
        paymentMethod: details.paymentMethod,
        lastFourDigits: details.lastFourDigits,
        expirationMonth: details.expirationMonth,
        expirationYear: details.expirationYear,
        isDefault: true,
      });

    if (!existing) {
      await this.billingCardsRepository.save(card);
    }

    if (subscription.billingCardId !== card.id) {
      subscription.assignBillingCard(card.id);
      await this.subscriptionsRepository.update(subscription);
    }

    return card;
  }
}
