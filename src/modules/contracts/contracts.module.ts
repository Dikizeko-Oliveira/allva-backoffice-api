import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { AnalysisScopeModule } from 'src/modules/analysis-scope/analysis-scope.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { InvoicesModule } from 'src/modules/invoices/invoices.module';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { ProvisioningModule } from 'src/modules/provisioning/provisioning.module';
import { SalesLeadsModule } from 'src/modules/sales-leads/sales-leads.module';
import { PrismaModule } from 'src/shared/infrastructure/database/prisma/prisma.module';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';
import { AttachSignedDocumentUseCase } from './application/use-cases/attach-signed-document.usecase';
import { ActivateContractUseCase } from './application/use-cases/activate-contract.usecase';
import { AdvanceContractLifecycleUseCase } from './application/use-cases/advance-contract-lifecycle.usecase';
import { AmendContractUseCase } from './application/use-cases/amend-contract.usecase';
import { ApplyDueAmendmentsUseCase } from './application/use-cases/apply-due-amendments.usecase';
import { IssueContractInvoiceUseCase } from './application/use-cases/issue-contract-invoice.usecase';
import { ContractAmendmentApplier } from './application/services/contract-amendment-applier';
import { ContractUsageService } from './application/services/contract-usage.service';
import { OrganizationAccessCloser } from './application/services/organization-access-closer';
import { CorrectContractUseCase } from './application/use-cases/correct-contract.usecase';
import { ManageContractUseCase } from './application/use-cases/manage-contract.usecase';
import { RenewContractUseCase } from './application/use-cases/renew-contract.usecase';
import { SettleContractInvoiceUseCase } from './application/use-cases/settle-contract-invoice.usecase';
import {
  CONTRACT_LIFECYCLE_QUEUE,
  ContractLifecycleProcessor,
} from './infrastructure/jobs/contract-lifecycle.processor';
import { ContractLifecycleScheduler } from './infrastructure/jobs/contract-lifecycle.scheduler';
import { AdminContractInvoicesController } from './infrastructure/http/controllers/admin-contract-invoices.controller';
import { AdminContractsController } from './infrastructure/http/controllers/admin-contracts.controller';
import { EnterpriseContractsRepositoryInterface } from './domain/ports/enterprise-contracts.repository';
import { ContractAmendmentsRepositoryInterface } from './domain/ports/contract-amendments.repository';
import { ContractAmendmentsPrismaRepository } from './infrastructure/database/prisma/contract-amendments-prisma.repository';
import { EnterpriseContractsPrismaRepository } from './infrastructure/database/prisma/enterprise-contracts-prisma.repository';

/**
 * O contrato Enterprise — o acordo comercial como agregado próprio.
 *
 * Depende de `provisioning` para criar a organização, de `sales-leads` para
 * saber quem é o titular, e de `accounts` para a autorização por papel de
 * plataforma. Nenhum deles depende dele: o contrato é quem orquestra.
 */
@Module({
  imports: [
    PrismaModule,
    AccountsModule,
    ProvisioningModule,
    SalesLeadsModule,
    // `OrganizationPlanPortInterface`: cancelar o contrato revoga a assinatura
    // da organização junto.
    OrganizationsModule,
    // `InvoicesRepositoryInterface`: a cobrança do contrato é fatura, e a
    // fatura já tem dono neste projeto.
    InvoicesModule,
    // O retrato de uso que o aditivo mostra ao operador: cada contagem vem de
    // quem já a calcula, para o número exibido ser o mesmo que o produto usa.
    IntegrationsModule,
    AnalysisScopeModule,
    // O PDF assinado vai para o mesmo bucket privado do avatar e do print de
    // suporte.
    StorageModule,
    BullModule.registerQueue({ name: CONTRACT_LIFECYCLE_QUEUE }),
  ],
  controllers: [AdminContractsController, AdminContractInvoicesController],
  providers: [
    ActivateContractUseCase,
    AttachSignedDocumentUseCase,
    AmendContractUseCase,
    ApplyDueAmendmentsUseCase,
    AdvanceContractLifecycleUseCase,
    ManageContractUseCase,
    CorrectContractUseCase,
    RenewContractUseCase,
    ContractUsageService,
    ContractAmendmentApplier,
    OrganizationAccessCloser,
    ContractLifecycleProcessor,
    ContractLifecycleScheduler,
    IssueContractInvoiceUseCase,
    SettleContractInvoiceUseCase,
    {
      provide: EnterpriseContractsRepositoryInterface,
      useClass: EnterpriseContractsPrismaRepository,
    },
    {
      provide: ContractAmendmentsRepositoryInterface,
      useClass: ContractAmendmentsPrismaRepository,
    },
  ],
  exports: [
    ActivateContractUseCase,
    ApplyDueAmendmentsUseCase,
    EnterpriseContractsRepositoryInterface,
  ],
})
export class ContractsModule {}
