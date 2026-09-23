import { Module } from '@nestjs/common';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import {
  GetAdminAccountUseCase,
  GetAdminOrganizationUseCase,
  GetAdminOverviewUseCase,
  ListAdminAuditLogsUseCase,
  ListAdminCustomersUseCase,
  ListAdminIntegrationsUseCase,
  ListAdminInvoicesUseCase,
  ListAdminJobRunsUseCase,
  ListAdminOperatorsUseCase,
  ListAdminOrganizationsUseCase,
  ListAdminSubscriptionsUseCase,
} from './application/use-cases';
import {
  AdminAccountsReaderInterface,
  AdminAuditReaderInterface,
  AdminBillingReaderInterface,
  AdminOrganizationsReaderInterface,
  AdminOverviewReaderInterface,
  AdminPlatformReaderInterface,
} from './domain/ports';
import { AdminAccountsPrismaReader } from './infrastructure/database/prisma/admin-accounts-prisma.reader';
import { AdminAuditPrismaReader } from './infrastructure/database/prisma/admin-audit-prisma.reader';
import { AdminBillingPrismaReader } from './infrastructure/database/prisma/admin-billing-prisma.reader';
import { AdminOrganizationsPrismaReader } from './infrastructure/database/prisma/admin-organizations-prisma.reader';
import { AdminOverviewPrismaReader } from './infrastructure/database/prisma/admin-overview-prisma.reader';
import { AdminPlatformPrismaReader } from './infrastructure/database/prisma/admin-platform-prisma.reader';
import {
  AdminAccountsReadController,
  AdminBillingReadController,
  AdminOrganizationsController,
  AdminPlatformReadController,
} from './infrastructure/http/controllers/admin-read.controllers';

/**
 * As leituras cross-org do backoffice (B1, B2, B4, B5, B6, B8, B9, B12, B14).
 *
 * Módulo de **leitura**, à parte dos donos do dado pela mesma razão do
 * `operations-hub`: ele atravessa organizações, contas, cobrança, integrações,
 * jobs e auditoria, e pendurá-lo em qualquer um deles faria esse módulo
 * depender de todos os outros. Aqui a única dependência injetada é `accounts`
 * (quem é o operador); o resto são funções puras de domínio — os tetos de
 * plano, o contrato que governa — importadas para que o painel responda com a
 * mesma regra que o produto aplica.
 */
@Module({
  imports: [AccountsModule],
  controllers: [
    AdminOrganizationsController,
    AdminAccountsReadController,
    AdminBillingReadController,
    AdminPlatformReadController,
  ],
  providers: [
    ListAdminOrganizationsUseCase,
    GetAdminOrganizationUseCase,
    ListAdminCustomersUseCase,
    ListAdminOperatorsUseCase,
    GetAdminAccountUseCase,
    ListAdminSubscriptionsUseCase,
    ListAdminInvoicesUseCase,
    ListAdminIntegrationsUseCase,
    ListAdminJobRunsUseCase,
    ListAdminAuditLogsUseCase,
    GetAdminOverviewUseCase,
    {
      provide: AdminOrganizationsReaderInterface,
      useClass: AdminOrganizationsPrismaReader,
    },
    {
      provide: AdminAccountsReaderInterface,
      useClass: AdminAccountsPrismaReader,
    },
    {
      provide: AdminBillingReaderInterface,
      useClass: AdminBillingPrismaReader,
    },
    {
      provide: AdminPlatformReaderInterface,
      useClass: AdminPlatformPrismaReader,
    },
    { provide: AdminAuditReaderInterface, useClass: AdminAuditPrismaReader },
    {
      provide: AdminOverviewReaderInterface,
      useClass: AdminOverviewPrismaReader,
    },
  ],
})
export class PlatformAdminModule {}
