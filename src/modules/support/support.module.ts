import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { OrganizationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { OrganizationsPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma';
import { PlansModule } from 'src/modules/plans/plans.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { SupportController } from './infrastructure/http/controllers/support.controller';
import { AdminSupportController } from './infrastructure/http/controllers/admin-support.controller';
import {
  CreateAdminSupportMessageUseCase,
  GetAdminSupportTicketUseCase,
  GetSupportOnboardingUseCase,
  GetSupportTicketUseCase,
  GetSupportTicketsSummaryUseCase,
  ListAdminSupportTicketsUseCase,
  ListSupportTicketsUseCase,
  ReplyToSupportTicketUseCase,
  SendSupportMessageUseCase,
  UpdateAdminSupportTicketUseCase,
} from './application/use-cases';
import { SupportTicketNotifierService } from './application/services/support-ticket-notifier.service';
import { SupportAttachmentService } from './application/services/support-attachment.service';
import { SupportCenterAccessService } from './application/services/support-center-access.service';
import {
  SupportOnboardingSignalsPortInterface,
  SupportOrganizationContextPortInterface,
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from './domain/ports';
import { SupportTicketsPrismaRepository } from './infrastructure/database/prisma/support-tickets-prisma.repository';
import { SupportTicketMessagesPrismaRepository } from './infrastructure/database/prisma/support-ticket-messages-prisma.repository';
import { SupportOnboardingSignalsPrismaRepository } from './infrastructure/database/prisma/support-onboarding-signals-prisma.repository';
import { SupportOrganizationContextPrismaRepository } from './infrastructure/database/prisma/support-organization-context-prisma.repository';

/**
 * Suporte: o Drawer (um POST) e a Central do Enterprise (três leituras).
 *
 * Reusa inteiramente `PlansModule` (entitlement), `EmailModule` (envio),
 * `StorageModule` (o mesmo bucket do avatar de conta, para o print opcional) e
 * `OrganizationsModule` — de onde vem também `OnboardingStatePortInterface`, a
 * porta que `GET /auth/me` já usa para saber se a integração está de pé. O
 * checklist de primeiros passos lê essa mesma porta em vez de escrever as
 * próprias consultas: nenhuma regra de plano, e nenhum sinal de onboarding,
 * nasce em duplicata aqui.
 *
 * A escrita de operador entrou com o painel (`allva-backoffice-web`):
 * `AdminSupportController` atende a fila cross-org, e a autorização dele não
 * passa por `EntitlementGuard` — vem de `PlatformRoleService`, importado de
 * `AccountsModule`. O que **não** entrou é o processo de atendimento: fila de
 * trabalho, histórico de atribuição, SLA e escalonamento continuam sendo do
 * backoffice (C1 no mapa de endpoints dele). Aqui mora o registro; lá, como a
 * Allva se organiza para chegar a ele.
 */
@Module({
  imports: [
    AccountsModule,
    OrganizationsModule,
    PlansModule,
    SubscriptionAccessModule,
    EmailModule,
    StorageModule,
  ],
  controllers: [SupportController, AdminSupportController],
  providers: [
    SendSupportMessageUseCase,
    ListSupportTicketsUseCase,
    GetSupportTicketsSummaryUseCase,
    GetSupportTicketUseCase,
    GetSupportOnboardingUseCase,
    ReplyToSupportTicketUseCase,
    ListAdminSupportTicketsUseCase,
    GetAdminSupportTicketUseCase,
    UpdateAdminSupportTicketUseCase,
    CreateAdminSupportMessageUseCase,
    SupportTicketNotifierService,
    SupportAttachmentService,
    SupportCenterAccessService,
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: OrganizationsRepositoryInterface,
      useClass: OrganizationsPrismaRepository,
    },
    {
      provide: SupportTicketsRepositoryInterface,
      useClass: SupportTicketsPrismaRepository,
    },
    {
      provide: SupportTicketMessagesRepositoryInterface,
      useClass: SupportTicketMessagesPrismaRepository,
    },
    {
      provide: SupportOnboardingSignalsPortInterface,
      useClass: SupportOnboardingSignalsPrismaRepository,
    },
    {
      provide: SupportOrganizationContextPortInterface,
      useClass: SupportOrganizationContextPrismaRepository,
    },
  ],
})
export class SupportModule {}
