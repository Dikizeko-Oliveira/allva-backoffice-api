import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { BillingStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { BackfillBillingHistoryUseCase } from 'src/modules/subscriptions/application/use-cases/backfill-billing-history.usecase';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';

export type ReconcileResult = {
  scanned: number;
  synced: number;
  failed: number;
  backfilled: number;
};

const RECONCILE_TARGET_STATUSES: BillingStatus[] = [
  'PENDING_PAYMENT',
  'PENDING_ACTIVATION',
  'PAST_DUE',
];

@Injectable()
export class ReconcileSubscriptionUseCase {
  private readonly logger = new Logger(ReconcileSubscriptionUseCase.name);

  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly stripeService: StripeService,
    private readonly backfillBillingHistory: BackfillBillingHistoryUseCase,
    private readonly organizationPlan: OrganizationPlanPortInterface,
  ) {}

  async execute(input?: { limit?: number }): Promise<ReconcileResult> {
    const limit = input?.limit ?? 100;
    const subscriptions =
      await this.subscriptionsRepository.listForReconciliation(
        RECONCILE_TARGET_STATUSES,
        limit,
      );

    let synced = 0;
    let failed = 0;
    let backfilled = 0;
    const now = new Date();

    for (const subscription of subscriptions) {
      try {
        // Grace period expiry takes priority — no external call needed
        if (
          subscription.billingStatus === 'PAST_DUE' &&
          subscription.gracePeriodEndsAt &&
          subscription.gracePeriodEndsAt <= now
        ) {
          subscription.expireGracePeriod();
          await this.subscriptionsRepository.update(subscription);

          /**
           * A organização perde o acesso junto com a conta.
           *
           * Este é o caminho de quem simplesmente **deixou de pagar** e nunca
           * chega a `customer.subscription.deleted`: a fatura falha, a graça de
           * um dia corre, e aqui a conta cai para `UNPAID`. Sem revogar a
           * organização, ela seguia `ACTIVE` com o plano pago gravado — e como
           * `resolve()` devolve o contexto mais permissivo dos dois, o produto
           * continuava aberto de graça, sem prazo para acabar.
           */
          const revoked = await this.organizationPlan.revokeForOwner({
            ownerAccountId: subscription.accountId,
            status: 'EXPIRED',
          });

          if (revoked === 0) {
            this.logger.warn(
              `Grace expiry of subscription=${subscription.id} revoked no organization for account ${subscription.accountId}`,
            );
          }

          synced += 1;
          continue;
        }

        if (!subscription.externalSubscriptionId) {
          continue;
        }

        if (subscription.billingProvider !== 'STRIPE') {
          // FREE plans have no provider counterpart to reconcile against.
          continue;
        }

        const remote = await this.stripeService.getStripeSubscription(
          subscription.externalSubscriptionId,
        );

        subscription.syncWithProvider({
          status: remote.status,
          nextBillingAt: remote.nextBillingAt,
          canceledAt: remote.canceledAt,
        });

        await this.subscriptionsRepository.update(subscription);
        synced += 1;

        /**
         * O plano pago desce para a organização — o mesmo que o webhook faz.
         *
         * Esta rotina existe para recuperar o que o webhook não entregou, e
         * recuperava **metade**: promovia a assinatura de conta a `ACTIVE` e
         * deixava `organization_subscriptions` no plano anterior. Como é essa
         * tabela que responde às dezesseis guardas de `ENFORCED_FEATURE_KEYS`
         * (`findPlanTypeByOrganizationId`), o cliente terminava pagando o
         * Profissional e recebendo os limites do teste gratuito — e sem nenhuma
         * outra rotina relendo isso depois, porque esta *era* a rotina.
         *
         * Só na subida: a revogação tem caminho próprio acima, e chamar isto
         * para uma assinatura cancelada reativaria a organização.
         */
        if (subscription.billingStatus === 'ACTIVE') {
          const propagated = await this.organizationPlan.syncPlanForOwner({
            ownerAccountId: subscription.accountId,
            planId: subscription.planId,
          });

          if (propagated === 0) {
            this.logger.error(
              `Reconciled paid plan ${subscription.planId} reached no organization for account ${subscription.accountId}`,
            );
          }
        }

        // Recover any paid invoice whose webhook never landed. Guarded on its
        // own so a backfill failure never aborts the status reconciliation.
        try {
          const result =
            await this.backfillBillingHistory.execute(subscription);
          backfilled += result.created;
        } catch (backfillError) {
          this.logger.warn(
            `Billing history backfill failed for subscription=${subscription.id}: ${
              backfillError instanceof Error
                ? backfillError.message
                : String(backfillError)
            }`,
          );
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Reconcile failed for subscription=${subscription.id} provider=${subscription.billingProvider}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Reconciliation finished: scanned=${subscriptions.length} synced=${synced} failed=${failed} backfilled=${backfilled}`,
    );

    return { scanned: subscriptions.length, synced, failed, backfilled };
  }
}
