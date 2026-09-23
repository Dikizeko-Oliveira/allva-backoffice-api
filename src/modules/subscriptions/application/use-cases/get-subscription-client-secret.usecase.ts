import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';

const RESUMABLE_STATUSES = ['INCOMPLETE', 'PENDING_PAYMENT'] as const;

@Injectable()
export class GetSubscriptionClientSecretUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly stripeService: StripeService,
  ) {}

  async execute(accountId: string) {
    const subscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (!subscription) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'No subscription found for this account',
      });
    }

    if (
      !RESUMABLE_STATUSES.includes(
        subscription.billingStatus as (typeof RESUMABLE_STATUSES)[number],
      )
    ) {
      throw new UnprocessableEntityException({
        code: 'SUBSCRIPTION_NOT_RESUMABLE',
        message: `Subscription with status ${subscription.billingStatus} cannot be resumed for payment`,
        billingStatus: subscription.billingStatus,
      });
    }

    if (subscription.billingProvider !== 'STRIPE') {
      throw new UnprocessableEntityException({
        code: 'PROVIDER_NOT_SUPPORTED',
        message:
          'Client secret retrieval is only supported for Stripe subscriptions',
        billingProvider: subscription.billingProvider,
      });
    }

    if (!subscription.externalSubscriptionId) {
      throw new UnprocessableEntityException({
        code: 'STRIPE_SUBSCRIPTION_ID_MISSING',
        message: 'Subscription has no linked Stripe subscription ID',
      });
    }

    const { clientSecret } =
      await this.stripeService.getClientSecretForIncompleteSubscription(
        subscription.externalSubscriptionId,
      );

    return {
      subscriptionId: subscription.id,
      planId: subscription.planId,
      billingStatus: subscription.billingStatus,
      provider: subscription.billingProvider,
      clientSecret,
    };
  }
}
