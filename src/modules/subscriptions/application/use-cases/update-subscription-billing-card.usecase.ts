import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  BillingCardsRepositoryInterface,
  SubscriptionsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import { BillingCard } from 'src/modules/subscriptions/domain/entities';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { AuditLogService } from 'src/modules/audit/application';

/**
 * Changes the card a Stripe subscription is charged on
 * (`PUT /api/v1/billing/payment-method`).
 *
 * The client flow is: `POST /payments/stripe/setup-intent` → confirm it in Stripe.js
 * → send the resulting `paymentMethodId` here. That replaces the Mercado Pago
 * `cardTokenId` + pre-existing `billingCardId` pair, which had no Stripe equivalent:
 * Stripe payment methods are created by the SetupIntent, not looked up from a local
 * list.
 */
@Injectable()
export class UpdateSubscriptionBillingCardUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly billingCardsRepository: BillingCardsRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly stripeService: StripeService,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(input: {
    accountId: string;
    paymentMethodId: string;
  }): Promise<BillingCard> {
    const subscription = await this.subscriptionsRepository.findByAccountId(
      input.accountId,
    );

    if (!subscription) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Subscription not found',
      });
    }

    if (!subscription.externalSubscriptionId) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_NOT_ON_PROVIDER',
        message:
          'Subscription has no Stripe counterpart; complete a checkout first.',
      });
    }

    const account = await this.accountsRepository.findById(input.accountId);

    if (!account?.stripeCustomerId) {
      throw new ConflictException({
        code: 'STRIPE_CUSTOMER_NOT_FOUND',
        message: 'Account has no Stripe customer to attach a card to',
      });
    }

    const details = await this.stripeService.setSubscriptionPaymentMethod({
      externalRef: subscription.externalSubscriptionId,
      stripeCustomerId: account.stripeCustomerId,
      paymentMethodId: input.paymentMethodId,
    });

    // Reuse the local row when the same payment method comes back, so repeating the
    // operation does not accumulate duplicate cards.
    const existing = await this.billingCardsRepository.findByExternalCardId(
      'STRIPE',
      details.externalCardId,
    );

    // Exactly one default per account: the card Stripe now charges.
    await this.billingCardsRepository.clearDefaultForAccount(
      input.accountId,
      'STRIPE',
    );

    if (existing) {
      // Written *after* the clear-default sweep, and through `syncFromProvider`, so
      // re-selecting a card already on file lands as default and with the details
      // Stripe reports now — a plain `update()` here rewrote the row with the
      // `isDefault: false` the sweep had just set, leaving the account with no
      // default card at all.
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
        accountId: input.accountId,
        provider: 'STRIPE',
        externalCustomerId: account.stripeCustomerId,
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

    subscription.assignBillingCard(card.id);
    await this.subscriptionsRepository.update(subscription);

    await this.auditLog.record({
      event: 'subscription.payment_method_changed',
      entityType: 'subscription',
      entityId: subscription.id,
      actorId: input.accountId,
      // Card identifiers only — never the payment method itself beyond its id.
      metadata: {
        brand: details.brand ?? null,
        last4: details.lastFourDigits,
      },
    });

    return card;
  }
}
