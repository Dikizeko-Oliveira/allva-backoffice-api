import { Module } from '@nestjs/common';
import { AdsModule } from 'src/modules/ads/ads.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { WasteModule } from 'src/modules/waste/waste.module';
import { AnalyticsAggregatorService } from './application/services/analytics-aggregator.service';
import { GetAnalyticsOverviewUseCase } from './application/use-cases/get-analytics-overview.usecase';
import { GetBudgetAllocationUseCase } from './application/use-cases/get-budget-allocation.usecase';
import { GetCrossChannelUseCase } from './application/use-cases/get-cross-channel.usecase';
import { GetPlatformHealthUseCase } from './application/use-cases/get-platform-health.usecase';
import { AnalyticsController } from './infrastructure/http/controllers/analytics.controller';

/**
 * `analytics` — rollups derivados de anúncio (§5.2).
 *
 * Importa `waste` pelo **read model**, não pela detecção: entrega 12 de A2-S5
 * manda os rollups passarem pela view `open_waste`, e o jeito de garantir isso é
 * consumir a mesma consulta que o módulo dono já expõe. Reescrevê-la aqui seria
 * a segunda cópia da agregação — e a que divergiria primeiro.
 */
import { CurrencyModule } from 'src/modules/currency/currency.module';
import { CampaignBudgetsRepositoryInterface } from './domain/ports/campaign-budgets.repository';
import { CampaignBudgetsPrismaRepository } from './infrastructure/database/prisma/campaign-budgets-prisma.repository';
import { CampaignCoverageRepositoryInterface } from './domain/ports/campaign-coverage.repository';
import { CampaignCoveragePrismaRepository } from './infrastructure/database/prisma/campaign-coverage-prisma.repository';
import { GetCoverageUseCase } from './application/use-cases/get-coverage.usecase';
import { GetBudgetPacingUseCase } from './application/use-cases/get-budget-pacing.usecase';

import { AIModule } from 'src/modules/ai/ai.module';
import { DailyDigestRepositoryInterface } from './domain/ports/daily-digest.repository';
import { DailyDigestNarrator } from './domain/ports/daily-digest.narrator';
import { DailyDigestPrismaRepository } from './infrastructure/database/prisma/daily-digest-prisma.repository';
import { RoutedDailyDigestNarrator } from './infrastructure/ai/routed-daily-digest.narrator';
import { DailyDigestService } from './application/services/daily-digest.service';
import { DailyDigestScheduler } from './infrastructure/schedulers/daily-digest.scheduler';
import { GetDailyDigestUseCase } from './application/use-cases/get-daily-digest.usecase';

@Module({
  imports: [
    SubscriptionAccessModule,
    IntegrationsModule,
    AdsModule,
    WasteModule,
    // O orçamento vem na moeda da conta e o gasto já está normalizado: a
    // conversão é do `currency`, que é o único dono de `fx_rates` (§16.10).
    CurrencyModule,
    // O roteamento multi-provider e a contabilidade de custo de IA vivem no
    // módulo `ai`, que é o dono deles — o resumo diário é só mais um consumidor.
    AIModule,
  ],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsAggregatorService,
    GetAnalyticsOverviewUseCase,
    GetPlatformHealthUseCase,
    GetCrossChannelUseCase,
    GetBudgetAllocationUseCase,
    GetBudgetPacingUseCase,
    GetDailyDigestUseCase,
    GetCoverageUseCase,
    DailyDigestService,
    DailyDigestScheduler,
    {
      provide: DailyDigestRepositoryInterface,
      useClass: DailyDigestPrismaRepository,
    },
    {
      provide: DailyDigestNarrator,
      useClass: RoutedDailyDigestNarrator,
    },
    {
      provide: CampaignBudgetsRepositoryInterface,
      useClass: CampaignBudgetsPrismaRepository,
    },
    {
      provide: CampaignCoverageRepositoryInterface,
      useClass: CampaignCoveragePrismaRepository,
    },
  ],
  exports: [AnalyticsAggregatorService],
})
export class AnalyticsModule {}
