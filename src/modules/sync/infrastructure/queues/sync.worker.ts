import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { isSyncableIntegrationStatus } from 'src/modules/integrations/domain/entities/integration.entity';
import { AdAccountDiscoveryService } from 'src/modules/sync/application/services/ad-account-discovery.service';
import { IngestAdAccountService } from 'src/modules/sync/application/services/ingest-ad-account.service';
import { JobCoordinatorService } from 'src/modules/sync/application/services/job-coordinator.service';
import { DataRetentionService } from 'src/modules/sync/application/services/data-retention.service';
import { PartitionMaintenanceService } from 'src/modules/sync/application/services/partition-maintenance.service';
import { ReconcileAdAccountService } from 'src/modules/sync/application/services/reconcile-ad-account.service';
import { RefreshAdsService } from 'src/modules/sync/application/services/refresh-ads.service';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { degradationFor } from 'src/modules/sync/domain/account-health';
import {
  DISCOVER_AD_ACCOUNTS_JOB,
  INGEST_AD_ACCOUNT_JOB,
  DATA_RETENTION_JOB,
  PARTITION_MAINTENANCE_JOB,
  RECONCILE_AD_ACCOUNT_JOB,
  REFRESH_ADS_JOB,
  SYNC_QUEUE,
} from './sync.constants';
import type {
  DiscoverAdAccountsJobData,
  IngestAdAccountJobData,
  PartitionMaintenanceJobData,
  ReconcileAdAccountJobData,
  RefreshAdsJobData,
} from './sync.dispatcher';

/**
 * O worker dos cinco fluxos.
 *
 * Cada handler roda **sob lease de `JobRun`** (§8.8): o coordenador adquire a
 * janela por takeover condicional, bate o heartbeat a `lease/3` e conclui sob a
 * guarda de posse. Um worker que perdeu a janela para outro não finaliza nada —
 * `SUCCEEDED` nunca reexecuta, então concluir sem posse abriria um buraco
 * permanente de processamento.
 */
@Processor(SYNC_QUEUE)
export class SyncWorker {
  private readonly logger = new Logger(SyncWorker.name);

  constructor(
    private readonly coordinator: JobCoordinatorService,
    private readonly ingest: IngestAdAccountService,
    private readonly reconcile: ReconcileAdAccountService,
    private readonly discovery: AdAccountDiscoveryService,
    private readonly refresh: RefreshAdsService,
    private readonly partitions: PartitionMaintenanceService,
    private readonly retention: DataRetentionService,
    private readonly accounts: AdAccountsSyncRepositoryInterface,
  ) {}

  @Process(INGEST_AD_ACCOUNT_JOB)
  async handleIngest(job: Job<IngestAdAccountJobData>): Promise<void> {
    const { ctx, adAccountId, forceFullScan, trigger } = job.data;
    const now = new Date();

    const outcome = await this.coordinator.runUnderLease(
      {
        jobName: forceFullScan ? 'ads-ingest-full' : 'ads-ingest',
        scopeId: adAccountId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        const account = await this.accounts.findById(adAccountId);
        if (!account) return { status: 'SKIPPED', reason: 'EMPTY_WINDOW' };

        if (!account.integrationId) {
          return { status: 'SKIPPED', reason: 'INTEGRATION_DISCONNECTED' };
        }

        // Token vencido ou integração desconectada não voltam sozinhos: só
        // reconectar muda o estado. Pular aqui, antes do passo 2 do ingest, é o
        // que evita tentar renovar o token a cada tick — que falharia igual,
        // gastando chamada de plataforma. O cron já não enfileira essas contas;
        // esta guarda cobre o disparo manual e a corrida entre os dois.
        if (!isSyncableIntegrationStatus(account.integrationStatus)) {
          return { status: 'SKIPPED', reason: 'INTEGRATION_DISCONNECTED' };
        }

        // §8.7: numa conta `UNREACHABLE` o ingest **falha e reporta**; ele não
        // é pulado, porque tentar de novo é justamente como ela volta. O que
        // não pode é o resto da inteligência rodar sobre o que não foi lido.
        if (!degradationFor(account.syncHealth).archiving) {
          this.logger.warn(
            `sync.degraded adAccountId=${adAccountId} health=${account.syncHealth}`,
          );
        }

        // Posse confirmada **antes** de gastar chamada de plataforma: escrita de
        // domínio é upsert e sobrevive à duplicação, cota de API não.
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.ingest.execute({
          adAccountId,
          trigger: trigger === 'MANUAL' ? 'MANUAL' : 'SCHEDULE',
          ctx,
          now,
          forceFullScan,
        });

        const work = {
          processedItems: result.adsUpserted,
          successfulItems: result.adsUpserted - result.quarantined,
          failedItems: result.quarantined,
          result: {
            metricRows: result.metricRows,
            archived: result.archived,
            wasComplete: result.wasComplete,
            archiveSuppressedReason: result.archiveSuppressedReason,
            /**
             * R4 medido, e não estimado (A2-S9, entrega 9). Fica no `JobRun`
             * porque é lá que se pergunta "quanto este ciclo custou?" — e a
             * pergunta só é respondível comparando duas janelas, que é
             * exatamente o que o histórico de `job_runs` guarda.
             */
            platformCalls: result.platformCalls,
          },
        };

        // Conta inalcançável fecha a janela como `FAILED`, e não `SUCCEEDED`:
        // `SUCCEEDED` nunca reexecuta, e uma leitura que não viu a conta inteira
        // precisa ser retentável dentro da mesma janela.
        return result.health === 'UNREACHABLE'
          ? {
              status: 'FAILED' as const,
              work,
              errorMessage:
                result.archiveSuppressedReason ?? 'conta inalcançável',
            }
          : { status: 'SUCCEEDED' as const, work };
      },
    );

    this.logger.log(
      `sync.ingest adAccountId=${adAccountId} outcome=${outcome.status}`,
    );
  }

  @Process(RECONCILE_AD_ACCOUNT_JOB)
  async handleReconcile(job: Job<ReconcileAdAccountJobData>): Promise<void> {
    const { ctx, adAccountId } = job.data;
    const now = new Date();

    await this.coordinator.runUnderLease(
      {
        jobName: 'ads-reconcile',
        scopeId: adAccountId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.reconcile.execute({ adAccountId, ctx, now });

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.verified + result.pending + result.drifted,
            successfulItems: result.verified,
            failedItems: result.drifted,
            result: { ...result },
          },
        };
      },
    );
  }

  @Process(DISCOVER_AD_ACCOUNTS_JOB)
  async handleDiscovery(job: Job<DiscoverAdAccountsJobData>): Promise<void> {
    const { ctx, integrationId } = job.data;
    const now = new Date();

    await this.coordinator.runUnderLease(
      {
        jobName: 'ad-account-discovery',
        scopeId: integrationId,
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.discovery.execute({ integrationId, ctx });

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.seen,
            successfulItems: result.discovered + result.rebound,
            failedItems: 0,
            result: { ...result },
          },
        };
      },
    );
  }

  /**
   * O refresh **não** roda sob lease: ele é sob demanda, por lote de anúncios, e
   * não tem janela. A exclusão que ele precisa é o debounce de 60 s, que é outro
   * mecanismo com outro propósito — coordenar dois workers numa janela que não
   * existe seria inventar contenção.
   */
  @Process(REFRESH_ADS_JOB)
  async handleRefresh(job: Job<RefreshAdsJobData>): Promise<void> {
    const { ctx, organizationId, adIds } = job.data;
    const outcome = await this.refresh.execute({ organizationId, adIds, ctx });

    this.logger.log(
      `sync.refresh pedidos=${outcome.requested} atualizados=${outcome.refreshed} ` +
        `debounce=${outcome.debounced} inalcançáveis=${outcome.skippedUnreachable}`,
    );
  }

  /**
   * §14.6 — a poda, sob o mesmo lease mensal de `JobRun`.
   *
   * O lease importa aqui mais do que em qualquer outro job: duas réplicas
   * tentando `DROP PARTITION` sobre a mesma tabela produzem erro numa e sucesso
   * na outra, e a que erra não tem como saber se a partição já não existia ou se
   * a operação falhou de verdade.
   */
  @Process(DATA_RETENTION_JOB)
  async handleRetention(job: Job<PartitionMaintenanceJobData>): Promise<void> {
    const { ctx } = job.data;
    const now = new Date();

    await this.coordinator.runUnderLease(
      {
        jobName: 'data-retention',
        scopeId: 'GLOBAL',
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.retention.execute(now);

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems:
              result.droppedPartitions.length +
              result.sampledScoreRows +
              result.purgedSyncOperations,
            successfulItems: result.droppedPartitions.length,
            failedItems: 0,
            result: {
              droppedPartitions: result.droppedPartitions,
              sampledScoreRows: result.sampledScoreRows,
              purgedSyncOperations: result.purgedSyncOperations,
            },
          },
        };
      },
    );
  }

  @Process(PARTITION_MAINTENANCE_JOB)
  async handlePartitions(job: Job<PartitionMaintenanceJobData>): Promise<void> {
    const { ctx } = job.data;
    const now = new Date();

    await this.coordinator.runUnderLease(
      {
        jobName: 'metrics-partition-maintenance',
        scopeId: 'global',
        now,
        correlationId: ctx.correlationId,
      },
      async (guard) => {
        if (!(await guard.stillOwned())) return { status: 'LOST_LEASE' };

        const result = await this.partitions.execute();

        return {
          status: 'SUCCEEDED',
          work: {
            processedItems: result.created.length,
            successfulItems: result.created.length,
            failedItems: result.marginLow ? 1 : 0,
            result: {
              monthsAhead: result.monthsAhead,
              created: result.created,
              defaultPartitionRows: result.defaultPartitionRows,
            },
          },
        };
      },
    );
  }
}
