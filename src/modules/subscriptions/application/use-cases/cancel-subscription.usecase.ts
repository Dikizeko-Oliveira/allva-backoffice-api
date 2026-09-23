import { BadRequestException, Injectable } from '@nestjs/common';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { AuditLogService } from 'src/modules/audit/application';

@Injectable()
export class CancelSubscriptionUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly stripeService: StripeService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Cancels wherever the subscription actually lives.
   *
   * Sprint 6 / M-3 fixed a silent no-op here: this use case handled the (now removed)
   * Mercado Pago path and fell off the end of the method for Stripe, assuming the
   * caller had already cancelled at the provider. That held for
   * `DELETE /payments/stripe/cancel` but not for `DELETE /subscriptions/cancel`, so a
   * Stripe subscriber received HTTP 200 while nothing was cancelled anywhere.
   *
   * Talking to the provider now belongs to the use case, so every entry point is
   * correct by construction instead of by convention.
   */
  async execute(accountId: string): Promise<void> {
    const subscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (!subscription) {
      throw new BadRequestException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Account has no subscription',
      });
    }

    if (subscription.status === 'CANCELED') {
      throw new BadRequestException({
        code: 'SUBSCRIPTION_ALREADY_CANCELED',
        message: 'Subscription is already canceled',
      });
    }

    if (!subscription.externalSubscriptionId) {
      // Nothing exists at a provider (e.g. a trial that never checked out), so the
      // local record is the whole truth.
      subscription.cancel();
      await this.subscriptionsRepository.update(subscription);
      await this.recordCancellation(accountId, subscription.id, 'local_only');
      return;
    }

    // Stripe cancels at period end, so the customer keeps access until the term
    // they paid for expires. Local state deliberately stays as-is until Stripe
    // fires `customer.subscription.deleted` — flipping it here would revoke access
    // that is still paid for.
    await this.stripeService.cancelSubscription({
      externalRef: subscription.externalSubscriptionId,
    });

    await this.recordCancellation(accountId, subscription.id, 'stripe');
  }

  private async recordCancellation(
    accountId: string,
    subscriptionId: string,
    via: 'stripe' | 'local_only',
  ): Promise<void> {
    await this.auditLog.record({
      event: 'subscription.canceled',
      entityType: 'subscription',
      entityId: subscriptionId,
      actorId: accountId,
      metadata: { via },
    });
  }
}
