import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AuditModule } from 'src/modules/audit/audit.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { PlatformClientsModule } from 'src/modules/platform-clients/platform-clients.module';
import { RecommendationsModule } from 'src/modules/recommendations/recommendations.module';
import { SecurityModule } from 'src/modules/security/security.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { SyncModule } from 'src/modules/sync/sync.module';
import { ActionCapabilityRegistryService } from './application/services/action-capability-registry.service';
import { ActionEnqueueService } from './application/services/action-enqueue.service';
import { ApplyPlanExecutorService } from './application/services/apply-plan-executor.service';
import { PerformActionService } from './application/services/perform-action.service';
import { RecommendationSettlementService } from './application/services/recommendation-settlement.service';
import { ReapExpiredExecutionsService } from './application/services/reap-expired-executions.service';
import { VerifyActionService } from './application/services/verify-action.service';
import { PlansModule } from 'src/modules/plans/plans.module';
import { ActionGuardEvaluatorService } from './application/services/action-guard-evaluator.service';
import { ApplyRecommendationPlanUseCase } from './application/use-cases/apply-recommendation-plan.usecase';
import { ApplyWasteFixUseCase } from './application/use-cases/apply-waste-fix.usecase';
import { ExecuteActionUseCase } from './application/use-cases/execute-action.usecase';
import { ExecuteBatchUseCase } from './application/use-cases/execute-batch.usecase';
import { GetActionExecutionUseCase } from './application/use-cases/get-action-execution.usecase';
import { ListAvailableActionsUseCase } from './application/use-cases/list-available-actions.usecase';
import { RevertActionUseCase } from './application/use-cases/revert-action.usecase';
import {
  GrantWriteConsentUseCase,
  ListWriteConsentsUseCase,
  RevokeWriteConsentUseCase,
  ToggleActionsKillSwitchUseCase,
} from './application/use-cases/write-consent.usecases';
import { ActionExecutionsRepositoryInterface } from './domain/ports/action-executions.repository';
import { ActionTargetsRepositoryInterface } from './domain/ports/action-targets.repository';
import { ActionWriteSettingsReader } from './domain/ports/action-write-settings.reader';
import { AdActionGateway } from './domain/ports/ad-action.gateway';
import { WriteConsentRepositoryInterface } from './domain/ports/write-consent.repository';
import { ActionExecutionsPrismaRepository } from './infrastructure/database/prisma/action-executions-prisma.repository';
import { ActionTargetsPrismaRepository } from './infrastructure/database/prisma/action-targets-prisma.repository';
import { ActionWriteSettingsPrismaReader } from './infrastructure/database/prisma/action-write-settings-prisma.reader';
import { WriteConsentPrismaRepository } from './infrastructure/database/prisma/write-consent-prisma.repository';
import { AdActionsController } from './infrastructure/http/controllers/ad-actions.controller';
import { RecommendationApplyController } from './infrastructure/http/controllers/recommendation-apply.controller';
import { WasteFixController } from './infrastructure/http/controllers/waste-fix.controller';
import { WriteConsentController } from './infrastructure/http/controllers/write-consent.controller';
import { GoogleAdActionGateway } from './infrastructure/providers/google/google-ad-action.gateway';
import { MetaAdActionGateway } from './infrastructure/providers/meta/meta-ad-action.gateway';
import { TikTokAdActionGateway } from './infrastructure/providers/tiktok/tiktok-ad-action.gateway';
import { PLATFORM_ACTIONS_QUEUE } from './infrastructure/queues/platform-actions.constants';
import { PlatformActionsDispatcher } from './infrastructure/queues/platform-actions.dispatcher';
import { PlatformActionsWorker } from './infrastructure/queues/platform-actions.worker';
import { PlatformActionsScheduler } from './infrastructure/schedulers/platform-actions.scheduler';

/**
 * `platform-actions` — **o único módulo que escreve em mídia paga** (§16.4).
 *
 * Não é o último do grafo por acaso: ele depende de `ads` para saber o alvo, de
 * `integrations` para a credencial e de `organizations` para a autorização, e
 * **ninguém depende dele**. Um módulo a montante que o importasse ganharia um
 * caminho de escrita sem passar pelas guardas de P5 — e a escrita resultante
 * seria indistinguível de uma autorizada na hora de auditar.
 *
 * `AdActionGateway` é multi-provider: o token de injeção resolve para a lista de
 * implementações, e `ActionCapabilityRegistryService` escolhe por mapa. As três
 * plataformas entraram assim em A2-S8 — o que mudou foi esta lista, e nenhum
 * `if` novo (P6, verificado por lint e por teste).
 */
@Module({
  imports: [
    PlansModule,
    SubscriptionAccessModule,
    IntegrationsModule,
    OrganizationsModule,
    PlatformClientsModule,
    AuditModule,
    SecurityModule,
    /**
     * `SyncModule` entra por dois motivos, e nenhum inverte o grafo — `sync` não
     * conhece `platform-actions`. O `JobCoordinatorService` dá ao reaper o mesmo
     * lease de `JobRun` que todo job de §8.8 usa, e o `SyncDispatcher` é como se
     * pede a releitura de um anúncio: §3.5 não deixa o escritor sair de
     * `PENDING_WRITE`, então quem fecha o ciclo é quem lê a plataforma.
     */
    SyncModule,
    /**
     * A2-S9 — a direção que §5.3 r.5 sempre declarou: **`platform-actions` é
     * downstream de `recommendations`**, e nunca o contrário. Aplicar um plano é
     * escrever, e o controller da rota veio para cá junto com a escrita (D3).
     */
    RecommendationsModule,
    BullModule.registerQueue({ name: PLATFORM_ACTIONS_QUEUE }),
  ],
  controllers: [
    AdActionsController,
    WriteConsentController,
    RecommendationApplyController,
    WasteFixController,
  ],
  providers: [
    MetaAdActionGateway,
    GoogleAdActionGateway,
    TikTokAdActionGateway,
    {
      /**
       * A lista de gateways como um provider só. A alternativa — injetar cada
       * um por token nomeado — faria a registry crescer um construtor a cada
       * plataforma, que é exatamente o acoplamento que o mapa existe para
       * evitar.
       */
      provide: AdActionGateway,
      useFactory: (
        meta: MetaAdActionGateway,
        google: GoogleAdActionGateway,
        tiktok: TikTokAdActionGateway,
      ) => [meta, google, tiktok],
      inject: [
        MetaAdActionGateway,
        GoogleAdActionGateway,
        TikTokAdActionGateway,
      ],
    },
    {
      provide: ActionCapabilityRegistryService,
      useFactory: (gateways: AdActionGateway[]) =>
        new ActionCapabilityRegistryService(gateways),
      inject: [AdActionGateway],
    },
    {
      provide: ActionTargetsRepositoryInterface,
      useClass: ActionTargetsPrismaRepository,
    },
    {
      provide: ActionExecutionsRepositoryInterface,
      useClass: ActionExecutionsPrismaRepository,
    },
    {
      provide: WriteConsentRepositoryInterface,
      useClass: WriteConsentPrismaRepository,
    },
    {
      provide: ActionWriteSettingsReader,
      useClass: ActionWriteSettingsPrismaReader,
    },
    ActionGuardEvaluatorService,
    ActionEnqueueService,
    ApplyPlanExecutorService,
    PerformActionService,
    RecommendationSettlementService,
    VerifyActionService,
    ReapExpiredExecutionsService,
    PlatformActionsDispatcher,
    PlatformActionsWorker,
    PlatformActionsScheduler,
    ListAvailableActionsUseCase,
    ExecuteActionUseCase,
    GetActionExecutionUseCase,
    ExecuteBatchUseCase,
    ApplyRecommendationPlanUseCase,
    ApplyWasteFixUseCase,
    RevertActionUseCase,
    GrantWriteConsentUseCase,
    RevokeWriteConsentUseCase,
    ListWriteConsentsUseCase,
    ToggleActionsKillSwitchUseCase,
  ],
  exports: [ActionCapabilityRegistryService],
})
export class PlatformActionsModule {}
