import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { OrganizationPlanPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { InvoicesPrismaRepository } from 'src/modules/invoices/infrastructure/database/prisma/invoices-prisma.repository';
import {
  BillingCardsRepositoryInterface,
  BillingWebhookEventsRepositoryInterface,
  PaymentsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import {
  GetSubscriptionBillingCardUseCase,
  HandleStripeWebhookUseCase,
  SyncSubscriptionBillingCardUseCase,
  UpdateSubscriptionBillingCardUseCase,
} from 'src/modules/subscriptions/application/use-cases';
import { BillingCardsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/billing-cards-prisma.repository';
import { BillingWebhookEventsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/billing-webhook-events-prisma.repository';
import { PaymentsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/payments-prisma.repository';
import { PaymentsController } from 'src/modules/subscriptions/infrastructure/http/controllers/payments.controller';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { SubscriptionsModule } from 'src/modules/subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule, SubscriptionAccessModule],
  controllers: [PaymentsController],
  providers: [
    HandleStripeWebhookUseCase,
    GetSubscriptionBillingCardUseCase,
    UpdateSubscriptionBillingCardUseCase,
    SyncSubscriptionBillingCardUseCase,
    {
      provide: PaymentsRepositoryInterface,
      useClass: PaymentsPrismaRepository,
    },
    {
      provide: InvoicesRepositoryInterface,
      useClass: InvoicesPrismaRepository,
    },
    {
      provide: BillingWebhookEventsRepositoryInterface,
      useClass: BillingWebhookEventsPrismaRepository,
    },
    {
      provide: BillingCardsRepositoryInterface,
      useClass: BillingCardsPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
    /**
     * Pela porta, não pelo módulo: `OrganizationsModule` importa
     * `SubscriptionAccessModule`, e importá-lo daqui fecharia um ciclo. É a
     * mesma escolha que `ProvisioningModule` faz com o repositório de planos.
     */
    {
      provide: OrganizationPlanPortInterface,
      useClass: OrganizationPlanPrismaRepository,
    },
    StripeService,
  ],
})
export class PaymentsModule {}
