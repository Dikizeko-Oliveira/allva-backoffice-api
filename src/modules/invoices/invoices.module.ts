import { Module } from '@nestjs/common';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { InvoicesPrismaRepository } from 'src/modules/invoices/infrastructure/database/prisma/invoices-prisma.repository';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import {
  CreateInvoiceUseCase,
  ListInvoicesUseCase,
  UpdateInvoiceStatusUseCase,
} from 'src/modules/invoices/application/use-cases';
import { InvoicesController } from 'src/modules/invoices/infrastructure/http/controllers/invoices.controller';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';

@Module({
  imports: [SubscriptionAccessModule],
  controllers: [InvoicesController],
  providers: [
    CreateInvoiceUseCase,
    ListInvoicesUseCase,
    UpdateInvoiceStatusUseCase,
    {
      provide: InvoicesRepositoryInterface,
      useClass: InvoicesPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
  ],
  // O contrato Enterprise emite e baixa fatura: a cobrança dele é fatura
  // como qualquer outra, e não merece uma tabela paralela.
  exports: [InvoicesRepositoryInterface],
})
export class InvoicesModule {}
