import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { OrganizationPlanPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { SubscriptionsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/subscription-prisma.repository';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { InvoicesPrismaRepository } from 'src/modules/invoices/infrastructure/database/prisma/invoices-prisma.repository';
import { PaymentsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { PaymentsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/payments-prisma.repository';
import { BackfillBillingHistoryUseCase } from 'src/modules/subscriptions/application/use-cases/backfill-billing-history.usecase';
import {
  CancelSubscriptionUseCase,
  CreateSubscriptionUseCase,
  DowngradeSubscriptionUseCase,
  GetSubscriptionClientSecretUseCase,
  ListSubscriptionsUseCase,
} from 'src/modules/subscriptions/application/use-cases';
import { SubscriptionsController } from 'src/modules/subscriptions/infrastructure/http/controllers/subscriptions.controller';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import {
  BILLING_RECONCILIATION_QUEUE,
  BillingReconciliationProcessor,
} from 'src/modules/subscriptions/access/infrastructure/jobs/billing-reconciliation.processor';
import { ReconcileSubscriptionUseCase } from 'src/modules/subscriptions/access/application/reconcile-subscription.usecase';
import { ExpireOrganizationTrialsUseCase } from 'src/modules/subscriptions/access/application/expire-organization-trials.usecase';
import { BillingReconciliationScheduler } from 'src/modules/subscriptions/access/infrastructure/jobs/billing-reconciliation.scheduler';

@Module({
  imports: [
    SubscriptionAccessModule,
    BullModule.registerQueue({
      name: BILLING_RECONCILIATION_QUEUE,
    }),
  ],
  exports: [
    CreateSubscriptionUseCase,
    CancelSubscriptionUseCase,
    SubscriptionsRepositoryInterface,
  ],
  controllers: [SubscriptionsController],
  providers: [
    CreateSubscriptionUseCase,
    DowngradeSubscriptionUseCase,
    CancelSubscriptionUseCase,
    ListSubscriptionsUseCase,
    GetSubscriptionClientSecretUseCase,
    ReconcileSubscriptionUseCase,
    ExpireOrganizationTrialsUseCase,
    BackfillBillingHistoryUseCase,
    BillingReconciliationProcessor,
    BillingReconciliationScheduler,
    StripeService,
    {
      provide: InvoicesRepositoryInterface,
      useClass: InvoicesPrismaRepository,
    },
    {
      provide: PaymentsRepositoryInterface,
      useClass: PaymentsPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    /**
     * Pela porta, não pelo módulo: `OrganizationsModule` importa
     * `SubscriptionAccessModule`, e importá-lo daqui fecharia um ciclo — a mesma
     * escolha que `PaymentsModule` já faz. `ReconcileSubscriptionUseCase` precisa
     * dela para revogar a organização quando a graça do atraso termina.
     */
    {
      provide: OrganizationPlanPortInterface,
      useClass: OrganizationPlanPrismaRepository,
    },
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
    {
      provide: SubscriptionsRepositoryInterface,
      useClass: SubscriptionsPrismaRepository,
    },
  ],
})
export class SubscriptionsModule {}
