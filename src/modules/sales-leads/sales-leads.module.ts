import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { SalesLeadsRepositoryInterface } from './domain/ports';
import { SalesLeadsPrismaRepository } from './infrastructure/database/prisma/sales-leads-prisma.repository';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { AdminSalesLeadsController } from './infrastructure/http/controllers/admin-sales-leads.controller';
import { SalesLeadsController } from './infrastructure/http/controllers/sales-leads.controller';
import {
  CreateAdminSalesLeadUseCase,
  CreateSalesLeadUseCase,
  GetSalesLeadUseCase,
  ListSalesLeadsUseCase,
  UpdateSalesLeadStatusUseCase,
} from './application/use-cases';
import { ProvisioningModule } from 'src/modules/provisioning/provisioning.module';

@Module({
  imports: [
    // Scoped rate limiting for this module: 30 req/min default, with a stricter
    // per-route limit on the public lead creation endpoint.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
    ProvisioningModule,
    // `PlatformRoleService`: a autorização por papel de plataforma que as três
    // rotas administrativas deste módulo exigem.
    AccountsModule,
  ],
  controllers: [SalesLeadsController, AdminSalesLeadsController],
  providers: [
    CreateSalesLeadUseCase,
    CreateAdminSalesLeadUseCase,
    ListSalesLeadsUseCase,
    GetSalesLeadUseCase,
    UpdateSalesLeadStatusUseCase,
    {
      provide: SalesLeadsRepositoryInterface,
      useClass: SalesLeadsPrismaRepository,
    },
  ],
  // O contrato precisa do lead para saber quem é o titular da organização que
  // vai provisionar — razão social, nome e e-mail moram lá.
  exports: [SalesLeadsRepositoryInterface],
})
export class SalesLeadsModule {}
