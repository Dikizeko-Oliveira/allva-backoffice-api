import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import {
  BillingCardsRepositoryInterface,
  SubscriptionsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import { BillingCardsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/billing-cards-prisma.repository';
import { SubscriptionsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/subscription-prisma.repository';
import { GetSubscriptionBillingCardUseCase } from 'src/modules/subscriptions/application/use-cases/get-subscription-billing-card.usecase';
import { UpdateSubscriptionBillingCardUseCase } from 'src/modules/subscriptions/application/use-cases/update-subscription-billing-card.usecase';
import { SyncSubscriptionBillingCardUseCase } from 'src/modules/subscriptions/application/use-cases/sync-subscription-billing-card.usecase';
import { ListSubscriptionsUseCase } from 'src/modules/subscriptions/application/use-cases/list-subscriptions.usecase';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { InvoicesPrismaRepository } from 'src/modules/invoices/infrastructure/database/prisma/invoices-prisma.repository';
import { ListInvoicesUseCase } from 'src/modules/invoices/application/use-cases/list-invoices.usecase';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { AnalysisScopeModule } from 'src/modules/analysis-scope/analysis-scope.module';
import { PlansModule } from 'src/modules/plans/plans.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BillingController } from './billing.controller';
import { ChangeSubscriptionUseCase } from './change-subscription.usecase';
import { GetBillingUsageUseCase } from './get-billing-usage.usecase';
import { MemberUsageService } from './member-usage.service';
import { UsageSnapshotService } from './usage-snapshot.service';

@Module({
  // IntegrationsModule for OwnerScopeResolverService: the usage meter has to scope
  // by the same owner (account vs organization) the analysis modules read with.
  //
  // PlansModule porque o teto que a barra mostra tem de ser o mesmo que a guarda
  // aplica — inclusive o negociado em contrato. A alternativa era um mapa de
  // limites aqui dentro, e era exatamente isso que fazia a tela de assinatura do
  // cliente Enterprise contradizer o contrato dele.
  //
  // AnalysisScopeModule porque "quantos anúncios entram na análise" é pergunta
  // de quem escreve `analysisEligibleAt`. Recontar aqui com um predicado
  // próprio mostraria ao cliente um número que o produto não usa — é o mesmo
  // motivo pelo qual `ContractUsageService` não reimplementa contagem nenhuma.
  imports: [
    SubscriptionAccessModule,
    IntegrationsModule,
    PlansModule,
    AnalysisScopeModule,
  ],
  controllers: [BillingController],
  providers: [
    ListSubscriptionsUseCase,
    GetSubscriptionBillingCardUseCase,
    UpdateSubscriptionBillingCardUseCase,
    SyncSubscriptionBillingCardUseCase,
    ChangeSubscriptionUseCase,
    ListInvoicesUseCase,
    GetBillingUsageUseCase,
    UsageSnapshotService,
    MemberUsageService,
    StripeService,
    PrismaService,
    {
      provide: SubscriptionsRepositoryInterface,
      useClass: SubscriptionsPrismaRepository,
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
    {
      provide: InvoicesRepositoryInterface,
      useClass: InvoicesPrismaRepository,
    },
  ],
})
export class BillingModule {}
