import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { assertSelfServePlan } from 'src/modules/plans/application/assert-self-serve-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import {
  DowngradeSubscriptionInputDto,
  DowngradeSubscriptionOutputDto,
} from '../dtos';

@Injectable()
export class DowngradeSubscriptionUseCase {
  constructor(
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
  ) {}

  async execute(
    accountId: string,
    input: DowngradeSubscriptionInputDto,
  ): Promise<DowngradeSubscriptionOutputDto> {
    const targetPlan = await this.plansRepository.findByType(input.planType);

    if (!targetPlan) {
      throw new InternalServerErrorException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not configured',
      });
    }

    if (targetPlan.type === 'FREE') {
      throw new BadRequestException({
        code: 'FREE_DOWNGRADE_NOT_ALLOWED',
        message: 'Downgrade to FREE plan is not allowed',
      });
    }

    /**
     * Quarta porta, e a mais silenciosa das quatro.
     *
     * `DowngradePlanType` aceita `ENTERPRISE`, e o que impedia a rota de mover
     * uma assinatura para lá era só a aritmética do `INVALID_DOWNGRADE_TARGET`:
     * o Enterprise é o mais caro, então nenhum downgrade chega nele. Isso é
     * coincidência de tabela de preços, não regra — um plano acima dele reabre
     * a porta sem que ninguém tenha decidido reabrir.
     */
    assertSelfServePlan(targetPlan.type);

    const currentSubscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (!currentSubscription) {
      throw new BadRequestException({
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'Account has no subscription',
      });
    }

    const currentPlan =
      currentSubscription.plan ??
      (await this.plansRepository.findById(currentSubscription.planId));

    if (!currentPlan) {
      throw new InternalServerErrorException({
        code: 'CURRENT_PLAN_NOT_FOUND',
        message: 'Current subscription plan not found',
      });
    }

    if (currentPlan.id === targetPlan.id) {
      throw new BadRequestException({
        code: 'PLAN_ALREADY_ACTIVE',
        message: 'Account is already on this plan',
      });
    }

    if (currentPlan.type === 'FREE') {
      throw new BadRequestException({
        code: 'DOWNGRADE_REQUIRES_PAID_SOURCE_PLAN',
        message: 'Downgrade requires a paid source plan',
      });
    }

    if (targetPlan.amount >= currentPlan.amount) {
      throw new BadRequestException({
        code: 'INVALID_DOWNGRADE_TARGET',
        message: 'Target plan must be lower than current plan',
      });
    }

    currentSubscription.updatePlan({
      planId: targetPlan.id,
      startedAt: new Date(),
    });

    await this.subscriptionsRepository.update(currentSubscription);

    return {};
  }
}
