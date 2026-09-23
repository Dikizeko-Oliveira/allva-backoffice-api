import { PlansModule } from 'src/modules/plans/plans.module';
import { AdsModule } from 'src/modules/ads/ads.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AuditModule } from 'src/modules/audit/audit.module';
import { CurrencyModule } from 'src/modules/currency/currency.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { PlatformClientsModule } from 'src/modules/platform-clients/platform-clients.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { RefreshIntegrationTokenUseCase } from 'src/modules/integrations/application/use-cases/refresh-integration-token.usecase';
import { AdAccountDiscoveryService } from './application/services/ad-account-discovery.service';
import { IngestAdAccountService } from './application/services/ingest-ad-account.service';
import { ScheduleAuditService } from './application/services/schedule-audit.service';
import { JobCoordinatorService } from './application/services/job-coordinator.service';
import { MetricsIngestService } from './application/services/metrics-ingest.service';
import { DataRetentionService } from './application/services/data-retention.service';
import { PartitionMaintenanceService } from './application/services/partition-maintenance.service';
import { PlatformBudgetService } from './application/services/platform-budget.service';
import { RebindIntegrationService } from './application/services/rebind-integration.service';
import { ReconcileAdAccountService } from './application/services/reconcile-ad-account.service';
import { RefreshAdsService } from './application/services/refresh-ads.service';
import { StructureIngestService } from './application/services/structure-ingest.service';
import { ListQuarantineUseCase } from './application/use-cases/list-quarantine.usecase';
import { RebindIntegrationUseCase } from './application/use-cases/rebind-integration.usecase';
import { SyncAdsBatchUseCase } from './application/use-cases/sync-ads-batch.usecase';
import { AdAccountsSyncRepositoryInterface } from './domain/ports/ad-accounts-sync.repository';
import { AdMetricsIngestRepositoryInterface } from './domain/ports/ad-metrics-ingest.repository';
import { AdStructureRepositoryInterface } from './domain/ports/ad-structure.repository';
import { JobRunsRepositoryInterface } from './domain/ports/job-runs.repository';
import { MetricPartitionsRepositoryInterface } from './domain/ports/metric-partitions.repository';
import { RetentionRepositoryInterface } from './domain/ports/retention.repository';
import { SyncOperationsRepositoryInterface } from './domain/ports/sync-operations.repository';
import { SyncQuarantineRepositoryInterface } from './domain/ports/sync-quarantine.repository';
import { AdAccountsSyncPrismaRepository } from './infrastructure/database/prisma/ad-accounts-sync-prisma.repository';
import { AdMetricsIngestPrismaRepository } from './infrastructure/database/prisma/ad-metrics-ingest-prisma.repository';
import { AdStructurePrismaRepository } from './infrastructure/database/prisma/ad-structure-prisma.repository';
import { JobRunsPrismaRepository } from './infrastructure/database/prisma/job-runs-prisma.repository';
import { MetricPartitionsPrismaRepository } from './infrastructure/database/prisma/metric-partitions-prisma.repository';
import { RetentionPrismaRepository } from './infrastructure/database/prisma/retention-prisma.repository';
import { SyncOperationsPrismaRepository } from './infrastructure/database/prisma/sync-operations-prisma.repository';
import { SyncQuarantinePrismaRepository } from './infrastructure/database/prisma/sync-quarantine-prisma.repository';
import { SyncController } from './infrastructure/http/controllers/sync.controller';
import { SYNC_QUEUE } from './infrastructure/queues/sync.constants';
import { SyncDispatcher } from './infrastructure/queues/sync.dispatcher';
import { SyncWorker } from './infrastructure/queues/sync.worker';
import { SyncScheduler } from './infrastructure/schedulers/sync.scheduler';

/**
 * `sync` — os cinco fluxos de §8, extraídos de `integrations`.
 *
 * A fronteira do deliverable 1 de A2-S3: `integrations` fica com **conexão,
 * OAuth e credencial**; `sync` fica com **observação** — o que existe na
 * plataforma, quando foi visto, quanto o dado já assentou e se dá para confiar
 * nele. Sem a separação, a mesma classe cuidaria de renovar token e de decidir
 * arquivar cinco mil anúncios, e a segunda decisão ficaria escondida atrás da
 * primeira.
 *
 * **Depende de `ads`? Não.** `ads` é a base do grafo (§5.3 r.1) e não pode
 * depender de ninguém; `sync` escreve nas tabelas do agregado por ports
 * próprios, e é o teste de propriedade de escrita de §5.4 que garante que
 * escreve **apenas** os campos de que é dono.
 */
@Module({
  imports: [
    // `SyncScheduler` peneira a ingestão pelo intervalo do plano.
    PlansModule,
    SubscriptionAccessModule,
    IntegrationsModule,
    /**
     * §9.5 passo 6 — o ingest pergunta a `ads` de quem cada anúncio novo nasceu.
     *
     * A direção é a única possível: `ads` é a base do grafo e não importa
     * ninguém, e `platform-actions` — que é quem produz o id novo — já importa
     * `sync` pelo lease do reaper. Consultá-lo daqui fecharia um ciclo. O port
     * mora em `ads` porque as colunas de linhagem são de `ads`.
     */
    AdsModule,
    PlatformClientsModule,
    CurrencyModule,
    AuditModule,
    BullModule.registerQueue({ name: SYNC_QUEUE }),
  ],
  controllers: [SyncController],
  providers: [
    // Coordenação
    JobCoordinatorService,
    PlatformBudgetService,

    // Os cinco fluxos
    IngestAdAccountService,
    ScheduleAuditService,
    StructureIngestService,
    MetricsIngestService,
    RefreshAdsService,
    ReconcileAdAccountService,
    RebindIntegrationService,
    AdAccountDiscoveryService,
    PartitionMaintenanceService,
    DataRetentionService,

    // Superfície
    SyncAdsBatchUseCase,
    ListQuarantineUseCase,
    RebindIntegrationUseCase,

    // Fila e cron
    SyncDispatcher,
    SyncWorker,
    SyncScheduler,

    // `integrations` não o exporta; o refresh de token é parte do passo 2 do
    // ingest, e reimplementá-lo aqui duplicaria a política de renovação.
    RefreshIntegrationTokenUseCase,

    {
      provide: AdAccountsSyncRepositoryInterface,
      useClass: AdAccountsSyncPrismaRepository,
    },
    {
      provide: AdStructureRepositoryInterface,
      useClass: AdStructurePrismaRepository,
    },
    {
      provide: AdMetricsIngestRepositoryInterface,
      useClass: AdMetricsIngestPrismaRepository,
    },
    {
      provide: SyncOperationsRepositoryInterface,
      useClass: SyncOperationsPrismaRepository,
    },
    {
      provide: SyncQuarantineRepositoryInterface,
      useClass: SyncQuarantinePrismaRepository,
    },
    { provide: JobRunsRepositoryInterface, useClass: JobRunsPrismaRepository },
    {
      provide: MetricPartitionsRepositoryInterface,
      useClass: MetricPartitionsPrismaRepository,
    },
    {
      provide: RetentionRepositoryInterface,
      useClass: RetentionPrismaRepository,
    },
  ],
  exports: [SyncDispatcher, JobCoordinatorService],
})
export class SyncModule {}
