import { AuthModule } from 'src/modules/auth/auth.module';
import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AdsModule } from 'src/modules/ads/ads.module';
import { AnalyticsModule } from 'src/modules/analytics/analytics.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { WasteModule } from 'src/modules/waste/waste.module';
import { RecommendationsModule } from 'src/modules/recommendations/recommendations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';
import {
  EmailReportUseCase,
  GenerateReportUseCase,
  GetReportDownloadUseCase,
  GetReportFileUseCase,
  ListReportTemplatesUseCase,
  ListReportsUseCase,
} from './application/use-cases/report-use-cases';
import { ReportBuilderService } from './application/services/report-builder.service';
import { ReportsRepositoryInterface } from './domain/ports/reports.repository';
import { ReportsPrismaRepository } from './infrastructure/database/prisma/reports-prisma.repository';
import { ReportsController } from './infrastructure/http/controllers/reports.controller';
import { ReportFileController } from './infrastructure/http/controllers/report-file.controller';
import { ReportDownloadTokenService } from './application/services/report-download-token.service';
import { PdfRendererService } from './infrastructure/pdf/pdf-renderer.service';
import { REPORTS_QUEUE } from './infrastructure/queues/reports.constants';
import { ReportsDispatcher } from './infrastructure/queues/reports.dispatcher';
import { ReportsWorker } from './infrastructure/queues/reports.worker';

@Module({
  imports: [
    AuthModule,
    PlansModule,
    SubscriptionAccessModule,
    IntegrationsModule,
    /**
     * A2-S9 — os templates leem `ads`, `waste` e `recommendations` diretamente.
     *
     * `AnalyticsModule` saiu junto com o relatório do v1: aquele somava
     * `metric_snapshots` e chamava o resultado de performance, prometendo
     * diagnóstico e entregando contabilidade. A v2.0 relata o que o produto
     * afirma — quais anúncios queimam dinheiro e o que aconteceu com o que já
     * foi corrigido —, e isso vem dos read models de `ads` e da medição de P8.
     *
     * **Ele voltou para `period-performance`, e a diferença é o nome.** Aquele
     * modelo é declaradamente a soma de um período e diz no próprio corpo que
     * não há score nem desperdício ali; reusar `AnalyticsAggregatorService` é o
     * que impede o relatório e a Visão Geral de divergirem por terem
     * reimplementado ROAS e CPA em dois lugares.
     */
    AdsModule,
    AnalyticsModule,
    WasteModule,
    RecommendationsModule,
    StorageModule,
    EmailModule,
    BullModule.registerQueue({ name: REPORTS_QUEUE }),
  ],
  controllers: [ReportsController, ReportFileController],
  providers: [
    ListReportTemplatesUseCase,
    GenerateReportUseCase,
    ListReportsUseCase,
    GetReportDownloadUseCase,
    GetReportFileUseCase,
    EmailReportUseCase,
    ReportDownloadTokenService,
    ReportBuilderService,
    PdfRendererService,
    ReportsDispatcher,
    ReportsWorker,
    {
      provide: ReportsRepositoryInterface,
      useClass: ReportsPrismaRepository,
    },
  ],
})
export class ReportsModule {}
