import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AdScoringModule } from 'src/modules/ad-scoring/ad-scoring.module';
import { AdsModule } from 'src/modules/ads/ads.module';
import { AuditModule } from 'src/modules/audit/audit.module';
import { CurrencyModule } from 'src/modules/currency/currency.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { SyncModule } from 'src/modules/sync/sync.module';
import { WasteModule } from 'src/modules/waste/waste.module';
import { GenerateRecommendationsService } from './application/services/generate-recommendations.service';
import { MeasureOutcomesService } from './application/services/measure-outcomes.service';
import { RecommendationApplicationService } from './application/services/recommendation-application.service';
import { RecommendationLifecycleService } from './application/services/recommendation-lifecycle.service';
import { ApplyRecommendationUseCase } from './application/use-cases/apply-recommendation.usecase';
import { DismissRecommendationUseCase } from './application/use-cases/dismiss-recommendation.usecase';
import {
  GetImpactSummaryUseCase,
  GetRecommendationUseCase,
  ListRecommendationsUseCase,
  ListSuppressionsUseCase,
  RemoveSuppressionUseCase,
} from './application/use-cases/recommendation-read-use-cases';
import { RecommendationOutcomesRepositoryInterface } from './domain/ports/recommendation-outcomes.repository';
import { RecommendationTargetsRepositoryInterface } from './domain/ports/recommendation-targets.repository';
import { RecommendationsRepositoryInterface } from './domain/ports/recommendations.repository';
import { SuppressionsRepositoryInterface } from './domain/ports/suppressions.repository';
import { RecommendationOutcomesPrismaRepository } from './infrastructure/database/prisma/recommendation-outcomes-prisma.repository';
import { RecommendationTargetsPrismaRepository } from './infrastructure/database/prisma/recommendation-targets-prisma.repository';
import { RecommendationsPrismaRepository } from './infrastructure/database/prisma/recommendations-prisma.repository';
import { SuppressionsPrismaRepository } from './infrastructure/database/prisma/suppressions-prisma.repository';
import { AdRecommendationsController } from './infrastructure/http/controllers/ad-recommendations.controller';
import { RecommendationsController } from './infrastructure/http/controllers/recommendations.controller';
import { RECOMMENDATIONS_QUEUE } from './infrastructure/queues/recommendations.constants';
import { RecommendationsDispatcher } from './infrastructure/queues/recommendations.dispatcher';
import { RecommendationsWorker } from './infrastructure/queues/recommendations.worker';
import { RecommendationsScheduler } from './infrastructure/schedulers/recommendations.scheduler';

/**
 * `recommendations` — **o único módulo que compõe** (§5.3 r.4).
 *
 * Waste, score e análise criativa viram um plano aqui, e só aqui. `waste` e
 * `creative-lab` não se conhecem (r.3); `ad-scoring` entra pelo port de leitura
 * (D2). É por isso que este módulo importa três e nenhum dos três o importa de
 * volta — a direção do grafo é o que impede o ciclo.
 *
 * **Não importa `platform-actions`** (r.5), e isso continua valendo depois de a
 * escrita existir: a direção é `platform-actions → recommendations`, nunca a
 * recíproca. §16.4 é verificado por teste — nenhum módulo a montante importa
 * `AdActionGateway`. O que sai daqui (`exports`, abaixo) é contrato de leitura e
 * de transição de estado, não caminho de escrita.
 */
@Module({
  imports: [
    SubscriptionAccessModule,
    IntegrationsModule,
    AdsModule,
    AdScoringModule,
    WasteModule,
    SyncModule,
    // A2-S9: a taxa fixa de `appliedAt` (M4) vem do dono único de `fx_rates`
    // (§16.10), e a trilha de §9.5 passo 9 vem do módulo de auditoria.
    CurrencyModule,
    AuditModule,
    BullModule.registerQueue({ name: RECOMMENDATIONS_QUEUE }),
  ],
  controllers: [RecommendationsController, AdRecommendationsController],
  providers: [
    GenerateRecommendationsService,
    RecommendationLifecycleService,
    MeasureOutcomesService,
    RecommendationApplicationService,
    ListRecommendationsUseCase,
    GetRecommendationUseCase,
    GetImpactSummaryUseCase,
    ListSuppressionsUseCase,
    RemoveSuppressionUseCase,
    DismissRecommendationUseCase,
    ApplyRecommendationUseCase,
    RecommendationsDispatcher,
    RecommendationsWorker,
    RecommendationsScheduler,
    {
      provide: RecommendationTargetsRepositoryInterface,
      useClass: RecommendationTargetsPrismaRepository,
    },
    {
      provide: RecommendationsRepositoryInterface,
      useClass: RecommendationsPrismaRepository,
    },
    {
      provide: SuppressionsRepositoryInterface,
      useClass: SuppressionsPrismaRepository,
    },
    {
      provide: RecommendationOutcomesRepositoryInterface,
      useClass: RecommendationOutcomesPrismaRepository,
    },
  ],
  /**
   * O que `platform-actions` consome (§5.3 r.5, D3).
   *
   * A revalidação de premissa e a liquidação da aplicação **não** são duplicadas
   * lá: duas definições de "a premissa ainda vale" divergem, e a que erra é
   * sempre a que ninguém revisita. O port de outcomes sai junto porque o gate de
   * P8 é verificado de fora.
   */
  exports: [
    // Sai para o `onboarding-chain` — ver ad-scoring.module.ts.
    RecommendationsDispatcher,
    ApplyRecommendationUseCase,
    RecommendationApplicationService,
    RecommendationOutcomesRepositoryInterface,
    // `apply-fix` (§10.9) traduz achado → recomendação ativa antes de aplicar.
    RecommendationsRepositoryInterface,
  ],
})
export class RecommendationsModule {}
