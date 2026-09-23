import { MembershipFreezeService } from 'src/modules/organizations/application/services/membership-freeze.service';
import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import {
  AcceptOrganizationInvitationUseCase,
  CreateOrganizationUseCase,
  DeleteOrganizationUseCase,
  GetMeContextUseCase,
  GetOrganizationCreationAllowanceUseCase,
  ListOrganizationInvitationsUseCase,
  ListOrganizationUseCase,
  ListMyOrganizationsUseCase,
  PreviewOrganizationInvitationUseCase,
  RemoveOrganizationUserUseCase,
  RevokeOrganizationInvitationUseCase,
  SendOrganizationInvitationUseCase,
  TransferOrganizationOwnershipUseCase,
  UpdateOrganizationUseCase,
  UpdateOrganizationUserRoleUseCase,
  UpdateOrganizationUserStatusUseCase,
} from 'src/modules/organizations/application/use-cases';
import { CurrentOrganizationResolver } from 'src/modules/organizations/application/current-organization.resolver';
import { OrganizationContextResolver } from 'src/modules/organizations/application/organization-context.resolver';
import { OnboardingStateService } from 'src/modules/organizations/application/onboarding-state.service';
import { OnboardingStatePrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma/onboarding-state-prisma.repository';
import { PermissionResolverService } from 'src/modules/organizations/application/permission-resolver.service';
import { OrganizationLimitService } from 'src/modules/organizations/application/services/organization-limit.service';
import { SeatLimitService } from 'src/modules/organizations/application/services/seat-limit.service';
import {
  OrganizationInvitationsRepositoryInterface,
  OrganizationPlanPortInterface,
  OrganizationQuotaPortInterface,
  OrganizationAdsSettingsPortInterface,
  OnboardingStatePortInterface,
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
  UsageCounterPortInterface,
} from 'src/modules/organizations/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { OrganizationQuotasController } from 'src/modules/organizations/infrastructure/http/controllers/organization-quotas.controller';
import { ManageOrganizationQuotaUseCase } from 'src/modules/organizations/application/use-cases/manage-organization-quota.usecase';
import { ManageOrganizationAdsSettingsUseCase } from 'src/modules/organizations/application/use-cases/manage-organization-ads-settings.usecase';
import { OrganizationsController } from 'src/modules/organizations/infrastructure/http/controllers/organizations.controller';
import { MeController } from 'src/modules/organizations/infrastructure/http/controllers/me.controller';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import {
  OrganizationInvitationsPrismaRepository,
  OrganizationPlanPrismaRepository,
  OrganizationQuotaPrismaRepository,
  OrganizationAdsSettingsPrismaRepository,
  OrganizationsPrismaRepository,
  OrganizationUsersPrismaRepository,
  UsageCounterPrismaRepository,
} from 'src/modules/organizations/infrastructure/database/prisma';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';

@Module({
  imports: [EmailModule, SubscriptionAccessModule],
  controllers: [
    OrganizationQuotasController,
    OrganizationsController,
    MeController,
  ],
  providers: [
    MembershipFreezeService,
    OnboardingStateService,
    CreateOrganizationUseCase,
    GetMeContextUseCase,
    ListOrganizationUseCase,
    SendOrganizationInvitationUseCase,
    AcceptOrganizationInvitationUseCase,
    PreviewOrganizationInvitationUseCase,
    ListOrganizationInvitationsUseCase,
    RevokeOrganizationInvitationUseCase,
    UpdateOrganizationUseCase,
    UpdateOrganizationUserRoleUseCase,
    UpdateOrganizationUserStatusUseCase,
    RemoveOrganizationUserUseCase,
    TransferOrganizationOwnershipUseCase,
    DeleteOrganizationUseCase,
    OrganizationContextResolver,
    CurrentOrganizationResolver,
    PermissionResolverService,
    OrganizationAccessGuard,
    SeatLimitService,
    OrganizationLimitService,
    GetOrganizationCreationAllowanceUseCase,
    ManageOrganizationQuotaUseCase,
    ManageOrganizationAdsSettingsUseCase,
    ListMyOrganizationsUseCase,
    {
      provide: OnboardingStatePortInterface,
      useClass: OnboardingStatePrismaRepository,
    },
    {
      provide: OrganizationsRepositoryInterface,
      useClass: OrganizationsPrismaRepository,
    },
    {
      provide: OrganizationPlanPortInterface,
      useClass: OrganizationPlanPrismaRepository,
    },
    {
      provide: OrganizationQuotaPortInterface,
      useClass: OrganizationQuotaPrismaRepository,
    },
    {
      provide: UsageCounterPortInterface,
      useClass: UsageCounterPrismaRepository,
    },
    {
      provide: OrganizationAdsSettingsPortInterface,
      useClass: OrganizationAdsSettingsPrismaRepository,
    },
    {
      provide: OrganizationUsersRepositoryInterface,
      useClass: OrganizationUsersPrismaRepository,
    },
    {
      provide: OrganizationInvitationsRepositoryInterface,
      useClass: OrganizationInvitationsPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    /**
     * O catálogo entra pela porta, não pelo módulo.
     *
     * `PlansModule` importa `OrganizationsModule` para resolver o plano de uma
     * organização; importá-lo de volta fecharia um ciclo, e o projeto não usa
     * `forwardRef` em lugar nenhum. `ProvisioningModule` já provê o repositório
     * de planos assim, pelo mesmo motivo.
     */
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
  ],
  exports: [
    MembershipFreezeService,
    OrganizationContextResolver,
    // O encerramento de conta apaga as organizações de que o titular é dono, e
    // reusa este caso de uso para que a cascata (participações, convites,
    // trilha) não exista em duas versões.
    DeleteOrganizationUseCase,
    PermissionResolverService,
    // A2-S10 — `platform-actions` resolve o plano da organização pela mesma
    // porta que `SeatLimitService`, para o produto não ter duas respostas a
    // "qual é o plano desta organização?".
    OrganizationPlanPortInterface,
    // O teto negociado acompanha o plano: quem pergunta "quantas contas esta
    // organização pode ter?" precisa das duas respostas, ou lê metade da regra.
    OrganizationQuotaPortInterface,
    // A reserva de cota sai junto do teto negociado porque as duas são metades
    // da mesma pergunta: quanto esta organização pode, e quanto já usou.
    // Separá-las é como o teto e o consumo passariam a discordar.
    UsageCounterPortInterface,
    // A emissão da fatura de contrato precisa do titular da organização: a
    // empresa é a devedora, mas cobrança chega a uma pessoa.
    OrganizationsRepositoryInterface,
    // O aditivo de contrato mostra ao operador quantos assentos estão em uso
    // antes de reduzir o teto. A contagem é a mesma que recusa o próximo
    // convite — recontá-la aqui daria dois números para a mesma pergunta.
    SeatLimitService,
    // O checklist de primeiros passos da Central de suporte pergunta "a
    // integração está conectada?" e "já entrou anúncio?" — exatamente o que
    // esta porta responde para `GET /auth/me`. Exportá-la é o que impede a
    // tela de suporte de escrever a segunda versão dessas consultas e
    // discordar da dashboard.
    OnboardingStatePortInterface,
    // B17: o backoffice bloqueia/reativa uma participação de fora da
    // organização, mas precisa preservar as mesmas regras de membros.
    OrganizationUsersRepositoryInterface,
  ],
})
export class OrganizationsModule {}
