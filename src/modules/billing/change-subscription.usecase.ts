import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { assertSelfServePlan } from 'src/modules/plans/application/assert-self-serve-plan';
import { resolveDowngradeEffectiveAt } from 'src/modules/subscriptions/domain/downgrade-schedule';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { AdAccountFreezeUseCase } from 'src/modules/integrations/application/use-cases/ad-account-freeze.usecase';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { AuditLogService } from 'src/modules/audit/application';

export type ChangeSubscriptionResult = {
  planId: string;
  /** `IMMEDIATE` for an upgrade, `AT_PERIOD_END` for a downgrade. */
  effect: 'IMMEDIATE' | 'AT_PERIOD_END';
  /** Only set for a scheduled downgrade — when the new plan starts. */
  effectiveAt?: Date;
};

/**
 * Plan change on Stripe (`POST /api/v1/billing/subscription/change`).
 *
 * Replaces a Mercado Pago-only implementation that created a **second** provider
 * subscription on every upgrade — which would have billed the customer twice once
 * Stripe became the provider.
 *
 * Product rule, standard for SaaS:
 * - **Upgrade** takes effect immediately and Stripe invoices the prorated
 *   difference now, because the customer starts using the better plan now.
 * - **Downgrade** takes effect at the end of the period already paid for. The local
 *   `planId` — which drives entitlement — is left alone until then, and the cheaper
 *   price applies from the next invoice. Downgrading early would take away access
 *   the customer already bought.
 */
@Injectable()
export class ChangeSubscriptionUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly stripeService: StripeService,
    private readonly auditLog: AuditLogService,
    private readonly freeze: AdAccountFreezeUseCase,
  ) {}

  async execute(input: {
    accountId: string;
    planId: string;
  }): Promise<ChangeSubscriptionResult> {
    const subscription = await this.subscriptionsRepository.findByAccountId(
      input.accountId,
    );

    if (!subscription) {
      throw new ConflictException({
        code: 'INVALID_SUBSCRIPTION_STATE',
        message:
          'Subscription change is only available for active subscriptions.',
        redirectTo: '/plans/subscriptions',
      });
    }

    const [currentPlan, targetPlan] = await Promise.all([
      this.plansRepository.findById(subscription.planId),
      this.plansRepository.findById(input.planId),
    ]);

    if (!targetPlan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not found',
      });
    }

    if (!currentPlan) {
      throw new InternalServerErrorException({
        code: 'CURRENT_PLAN_NOT_FOUND',
        message: 'Current subscription plan not found',
      });
    }

    if (currentPlan.id === targetPlan.id) {
      throw new ConflictException({
        code: 'PLAN_ALREADY_ACTIVE',
        message: 'Account is already on this plan',
      });
    }

    if (targetPlan.type === 'FREE') {
      throw new BadRequestException({
        code: 'FREE_CHANGE_NOT_ALLOWED',
        message: 'Cannot change to FREE plan via this endpoint',
      });
    }

    // Subir para um plano negociado é uma conversa com o comercial, não um
    // `POST`: a proposta define assentos, cotas e o preço que a Stripe vai
    // cobrar. Trocar por aqui migraria a assinatura para o piso de vitrine.
    assertSelfServePlan(targetPlan.type);

    if (!targetPlan.stripePriceId) {
      // Without a price there is nothing to move the subscription to; failing here
      // beats letting Stripe reject it with a less obvious error.
      throw new UnprocessableEntityException({
        code: 'STRIPE_PRICE_NOT_CONFIGURED',
        message: `Plan ${targetPlan.name} has no Stripe price configured`,
      });
    }

    if (!subscription.externalSubscriptionId) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_NOT_ON_PROVIDER',
        message:
          'Subscription has no Stripe counterpart; start a checkout instead of changing the plan.',
      });
    }

    const isDowngrade = targetPlan.amount < currentPlan.amount;

    const result = await this.stripeService.changeSubscriptionPlan({
      externalRef: subscription.externalSubscriptionId,
      newStripePriceId: targetPlan.stripePriceId,
      prorate: !isDowngrade,
    });

    if (isDowngrade) {
      /**
       * A queda só pode ser agendada para o **futuro**.
       *
       * `currentPeriodEnd` é a data até quando o cliente já pagou, e
       * `expiresAt` é a reserva local. Qualquer uma das duas no passado -
       * porque o provedor não devolveu o campo, porque a assinatura acabou de
       * ser criada - faz `applyScheduledDowngradeIfDue()` disparar no próximo
       * webhook, e o downgrade "para o fim do período" vira imediato: o cliente
       * perde hoje o plano que pagou até o mês que vem.
       *
       * Foi exatamente o que aconteceu enquanto o fim de período era lido do
       * `billing_cycle_anchor`. Aquele bug está corrigido na origem; esta
       * guarda existe para que a próxima data ruim vinda do provedor custe um
       * agendamento conservador, e não o acesso de um cliente pagante.
       */
      const effectiveAt = resolveDowngradeEffectiveAt(
        result.currentPeriodEnd ?? subscription.expiresAt,
      );

      subscription.scheduleDowngrade({
        planId: targetPlan.id,
        effectiveAt,
      });
      await this.subscriptionsRepository.update(subscription);

      /**
       * O congelamento é agendado **junto com** o downgrade, e não deixado para
       * a data.
       *
       * Duas razões. A tela precisa poder dizer hoje o que vai ficar congelado —
       * calcular só na virada faria o usuário descobrir depois. E quem aplicaria
       * o plano é o webhook da Stripe: um congelamento que dependesse dele
       * simplesmente não aconteceria se ele falhasse, e o teto do plano voltaria
       * a ser decorativo. Carimbada a data futura, a leitura decide sozinha.
       */
      await this.freeze.scheduleForAccount(
        input.accountId,
        { id: targetPlan.id, type: targetPlan.type },
        effectiveAt,
      );
      await this.record(input.accountId, subscription.id, targetPlan.id, {
        direction: 'downgrade',
        effect: 'AT_PERIOD_END',
        effectiveAt: effectiveAt.toISOString(),
      });

      return {
        planId: targetPlan.id,
        effect: 'AT_PERIOD_END',
        effectiveAt,
      };
    }

    // An upgrade supersedes any downgrade still waiting to land.
    subscription.clearScheduledDowngrade();
    // E desfaz o congelamento junto: subir de plano restaura o que havia,
    // inclusive o que já tinha congelado numa queda anterior.
    await this.freeze.upgradeForAccount(input.accountId, targetPlan.id);
    subscription.activatePaidPlan({
      planId: targetPlan.id,
      startedAt: new Date(),
      billingProvider: 'STRIPE',
      externalSubscriptionId: subscription.externalSubscriptionId,
      nextBillingAt: result.currentPeriodEnd,
    });

    await this.subscriptionsRepository.update(subscription);
    await this.record(input.accountId, subscription.id, targetPlan.id, {
      direction: 'upgrade',
      effect: 'IMMEDIATE',
    });

    return { planId: targetPlan.id, effect: 'IMMEDIATE' };
  }

  private async record(
    accountId: string,
    subscriptionId: string,
    planId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record({
      event: 'subscription.plan_changed',
      entityType: 'subscription',
      entityId: subscriptionId,
      actorId: accountId,
      metadata: { planId, ...metadata },
    });
  }
}
