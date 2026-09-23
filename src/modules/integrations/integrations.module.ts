import { SeatFreezeUseCase } from 'src/modules/integrations/application/use-cases/seat-freeze.usecase';
import { DowngradeContextResolver } from 'src/modules/integrations/application/services/downgrade-context.resolver';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { ProvisioningModule } from 'src/modules/provisioning/provisioning.module';
import { AdAccountFreezeUseCase } from 'src/modules/integrations/application/use-cases/ad-account-freeze.usecase';
import { AdAccountFreezeService } from 'src/modules/integrations/application/services/ad-account-freeze.service';
import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { JwtServiceInterface } from 'src/modules/auth/domain/ports';
import { JwtJoseProvider } from 'src/modules/auth/infrastructure/services/jwt-jose.provider';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import {
  OrganizationUsersRepositoryInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { OrganizationsPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma/organizations-prisma.repository';
import { OrganizationUsersPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma/organization-users-prisma.repository';
import { IntegrationsController } from 'src/modules/integrations/infrastructure/http/controllers/integrations.controller';
import { MetaController } from 'src/modules/integrations/meta/controllers/meta.controller';
import { MetaApiService } from 'src/modules/integrations/meta/services/meta-api.service';
import { ConnectGoogleAccountUseCase } from 'src/modules/integrations/google/use-cases/connect-google-account.use-case';
import { ConnectMetaAccountUseCase } from 'src/modules/integrations/meta/use-cases/connect-meta-account.use-case';
import { ConnectTikTokAccountUseCase } from 'src/modules/integrations/tiktok/use-cases/connect-tiktok-account.use-case';
import {
  AdAccountsRepositoryInterface,
  IntegrationsRepositoryInterface,
} from 'src/modules/integrations/domain/ports';
import {
  AdAccountsPrismaRepository,
  IntegrationsPrismaRepository,
} from 'src/modules/integrations/infrastructure/database/prisma';
import {
  CreateAdAccountUseCase,
  CreateIntegrationUseCase,
  DisconnectIntegrationUseCase,
  GetIntegrationSyncStatusUseCase,
  LinkAdAccountUseCase,
  ListIntegrationsUseCase,
  ListPlatformAdAccountsUseCase,
  RefreshIntegrationTokenUseCase,
  UnlinkAdAccountUseCase,
} from 'src/modules/integrations/application/use-cases';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { AdAccountLinkerService } from 'src/modules/integrations/application/services/ad-account-linker.service';
import { IntegrationDisconnectionService } from 'src/modules/integrations/application/services/integration-disconnection.service';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { GoogleAdsProvider } from 'src/modules/integrations/infrastructure/providers/google/google-ads.provider';
import { MetaAdsProvider } from 'src/modules/integrations/infrastructure/providers/meta/meta-ads.provider';
import { TikTokAdsProvider } from 'src/modules/integrations/infrastructure/providers/tiktok/tiktok-ads.provider';
import { OrganizationDeletedListener } from 'src/modules/integrations/infrastructure/events/organization-deleted.listener';
import { INTEGRATION_REVOCATION_QUEUE } from 'src/modules/integrations/infrastructure/queues/integration-revocation.constants';
import { IntegrationRevocationDispatcher } from 'src/modules/integrations/infrastructure/queues/integration-revocation.dispatcher';
import { IntegrationRevocationWorker } from 'src/modules/integrations/infrastructure/queues/integration-revocation.worker';
import { PlatformCredentialProvider } from 'src/modules/platform-clients/domain/ports/platform-credential.provider';
import { PlatformClientsModule } from 'src/modules/platform-clients/platform-clients.module';
import { PrismaPlatformCredentialProvider } from 'src/modules/integrations/infrastructure/providers/prisma-platform-credential.provider';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';

@Module({
  // A fila de ingest do v1 saiu com as tabelas que ela alimentava. O módulo
  // `sync` de A2-S3 registra a sua, com os cinco fluxos e o lease de `JobRun`.
  imports: [
    OrganizationsModule,
    ProvisioningModule,
    SubscriptionAccessModule,
    PlatformClientsModule,
    PlansModule,
    // A revogação das credenciais de uma organização excluída: o evento chega
    // síncrono, e três APIs externas não cabem dentro da resposta do `DELETE`.
    BullModule.registerQueue({ name: INTEGRATION_REVOCATION_QUEUE }),
  ],
  controllers: [IntegrationsController, MetaController],
  providers: [
    SeatFreezeUseCase,
    DowngradeContextResolver,
    AdAccountFreezeUseCase,
    AdAccountFreezeService,
    // Use cases
    CreateIntegrationUseCase,
    CreateAdAccountUseCase,
    ListIntegrationsUseCase,
    ListPlatformAdAccountsUseCase,
    LinkAdAccountUseCase,
    UnlinkAdAccountUseCase,
    DisconnectIntegrationUseCase,
    GetIntegrationSyncStatusUseCase,
    RefreshIntegrationTokenUseCase,
    ConnectMetaAccountUseCase,
    ConnectGoogleAccountUseCase,
    ConnectTikTokAccountUseCase,

    // Services
    OwnerScopeResolverService,
    AdAccountLinkerService,
    IntegrationDisconnectionService,

    // Exclusão de organização → revogação
    OrganizationDeletedListener,
    IntegrationRevocationDispatcher,
    IntegrationRevocationWorker,

    // Providers
    MetaApiService,
    MetaAdsProvider,
    GoogleAdsProvider,
    TikTokAdsProvider,
    AdsProviderFactory,

    // Repositories
    {
      provide: IntegrationsRepositoryInterface,
      useClass: IntegrationsPrismaRepository,
    },
    // D1: `platform-clients` declara o contrato, `integrations` o implementa.
    // É a inversão que impede o ciclo entre transporte e credencial.
    {
      provide: PlatformCredentialProvider,
      useClass: PrismaPlatformCredentialProvider,
    },
    {
      provide: AdAccountsRepositoryInterface,
      useClass: AdAccountsPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: OrganizationsRepositoryInterface,
      useClass: OrganizationsPrismaRepository,
    },
    {
      provide: OrganizationUsersRepositoryInterface,
      useClass: OrganizationUsersPrismaRepository,
    },
    {
      provide: JwtServiceInterface,
      useClass: JwtJoseProvider,
    },
  ],
  exports: [
    AdAccountFreezeUseCase,
    AdAccountFreezeService,
    AdsProviderFactory,
    OwnerScopeResolverService,
    AdAccountLinkerService,
    IntegrationsRepositoryInterface,
    AdAccountsRepositoryInterface,
    PlatformCredentialProvider,
  ],
})
export class IntegrationsModule {}
