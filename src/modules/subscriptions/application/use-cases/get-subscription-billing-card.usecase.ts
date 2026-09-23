import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BillingCardsRepositoryInterface,
  SubscriptionsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import { BillingCard } from 'src/modules/subscriptions/domain/entities';
import { SyncSubscriptionBillingCardUseCase } from './sync-subscription-billing-card.usecase';

@Injectable()
export class GetSubscriptionBillingCardUseCase {
  private readonly logger = new Logger(GetSubscriptionBillingCardUseCase.name);

  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly billingCardsRepository: BillingCardsRepositoryInterface,
    private readonly syncSubscriptionBillingCard: SyncSubscriptionBillingCardUseCase,
  ) {}

  async execute(accountId: string): Promise<BillingCard | null> {
    const subscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (!subscription) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Subscription not found',
      });
    }

    const local = subscription.billingCardId
      ? await this.billingCardsRepository.findById(subscription.billingCardId)
      : null;

    if (local) return local;

    /**
     * No local card is not proof there is no card: a subscription paid at
     * checkout has one at Stripe that was never written here. Repair the record
     * on read — see {@link SyncSubscriptionBillingCardUseCase}.
     *
     * Never fatal. If Stripe is unreachable this endpoint answers "no card",
     * exactly what it did before, instead of turning the billing screen into a
     * 500.
     */
    try {
      return await this.syncSubscriptionBillingCard.execute(subscription);
    } catch (error) {
      this.logger.error(
        `Failed to recover the billing card of subscription ${subscription.id} from Stripe: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
