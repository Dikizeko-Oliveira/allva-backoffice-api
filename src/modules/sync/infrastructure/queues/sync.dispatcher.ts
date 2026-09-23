import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import {
  DISCOVER_AD_ACCOUNTS_JOB,
  INGEST_AD_ACCOUNT_JOB,
  DATA_RETENTION_JOB,
  PARTITION_MAINTENANCE_JOB,
  RECONCILE_AD_ACCOUNT_JOB,
  REFRESH_ADS_JOB,
  SYNC_QUEUE,
} from './sync.constants';

/**
 * **Todo payload carrega `JobContext`** (§5.6.2, ⊕16).
 *
 * `EventEmitter2` é in-process: assim que um handler enfileira um job, a cadeia
 * de causalidade morre — e morre exatamente nos saltos que se quer auditar,
 * porque os triviais são os que ficam no mesmo processo. Sem o contexto na fila,
 * "tudo que aconteceu por causa do ingest das 14h" deixa de ser respondível na
 * primeira fronteira assíncrona.
 */
export type IngestAdAccountJobData = {
  ctx: JobContext;
  adAccountId: string;
  forceFullScan?: boolean;
  trigger: 'SCHEDULE' | 'MANUAL';
};

export type ReconcileAdAccountJobData = {
  ctx: JobContext;
  adAccountId: string;
};

export type DiscoverAdAccountsJobData = {
  ctx: JobContext;
  integrationId: string;
};

export type RefreshAdsJobData = {
  ctx: JobContext;
  organizationId: string;
  adIds: string[];
};

export type PartitionMaintenanceJobData = {
  ctx: JobContext;
};

@Injectable()
export class SyncDispatcher {
  constructor(@InjectQueue(SYNC_QUEUE) private readonly queue: Queue) {}

  /**
   * `jobId` derivado do escopo colapsa pedidos repetidos da mesma conta na fila.
   *
   * Não substitui o lease de `JobRun` — Bull esquece ids evictados por
   * `removeOnComplete`, e duas réplicas podem enfileirar em instantes
   * diferentes. É a primeira linha de defesa, e a segunda é a que vale.
   *
   * **O tipo de varredura entra na chave.** Sem ele, um pedido de varredura
   * completa era descartado em silêncio quando o cron horário já tivesse
   * enfileirado um incremental para a mesma conta naquela hora: mesma conta,
   * mesma hora, mesmo id. O ciclo que rodava era o incremental, e a conta recém
   * conectada continuava esperando a madrugada — mas só às vezes, conforme o
   * minuto em que o usuário clicasse, que é a pior forma de um defeito
   * aparecer.
   */
  async ingest(data: IngestAdAccountJobData): Promise<void> {
    const scan = data.forceFullScan ? 'full' : 'inc';

    await this.queue.add(INGEST_AD_ACCOUNT_JOB, data, {
      jobId: `${INGEST_AD_ACCOUNT_JOB}:${data.adAccountId}:${scan}:${hourKey()}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }

  async reconcile(data: ReconcileAdAccountJobData): Promise<void> {
    await this.queue.add(RECONCILE_AD_ACCOUNT_JOB, data, {
      jobId: `${RECONCILE_AD_ACCOUNT_JOB}:${data.adAccountId}:${hourKey()}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }

  async discover(data: DiscoverAdAccountsJobData): Promise<void> {
    await this.queue.add(DISCOVER_AD_ACCOUNTS_JOB, data, {
      jobId: `${DISCOVER_AD_ACCOUNTS_JOB}:${data.integrationId}:${dayKey()}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    });
  }

  async refresh(data: RefreshAdsJobData): Promise<void> {
    await this.queue.add(REFRESH_ADS_JOB, data, {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }

  /**
   * §14.6 — a poda. **Mesma forma do job de partições, efeito oposto.**
   *
   * `attempts: 1`, e não 3 como a manutenção: a criação de partição é
   * idempotente e vale a pena repetir; a poda é destrutiva, e um retry
   * automático sobre uma falha que ninguém leu é a última coisa que se quer
   * numa rotina sem desfazer. A janela mensal do `JobRun` traz o job de volta no
   * mês seguinte, e o `warn` do serviço é o que chama alguém antes disso.
   */
  async applyRetention(data: PartitionMaintenanceJobData): Promise<void> {
    await this.queue.add(DATA_RETENTION_JOB, data, {
      jobId: `${DATA_RETENTION_JOB}:${dayKey()}`,
      attempts: 1,
      removeOnComplete: 20,
      removeOnFail: 50,
    });
  }

  async maintainPartitions(data: PartitionMaintenanceJobData): Promise<void> {
    await this.queue.add(PARTITION_MAINTENANCE_JOB, data, {
      jobId: `${PARTITION_MAINTENANCE_JOB}:${dayKey()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 300_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    });
  }
}

function hourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
