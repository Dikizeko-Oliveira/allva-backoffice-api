import { Injectable, Logger } from '@nestjs/common';
import {
  JobLease,
  JobRunsRepositoryInterface,
} from 'src/modules/sync/domain/ports/job-runs.repository';
import {
  JobSkipReason,
  SYNC_JOBS,
  SyncJobName,
  heartbeatIntervalMs,
} from 'src/modules/sync/domain/job-schedule';
import { windowKeyFor } from 'src/modules/sync/domain/sync-window';

/**
 * O que o trabalho recebe para provar que ainda é dono da janela.
 *
 * *"Posse verificada em toda escrita, não só na renovação"* (⊕14). Renovar é o
 * menos perigoso que um worker zumbi faz; **concluir** é o destrutivo. E antes
 * de todo efeito colateral não idempotente a posse é consultada de novo —
 * escrita de domínio é upsert por chave e sobrevive à duplicação, mas chamada de
 * plataforma consome cota e chamada de LLM é dinheiro, e dobrá-la viola P9.
 */
export type LeaseGuard = {
  lease: JobLease;
  stillOwned(): Promise<boolean>;
};

export type JobWorkResult = {
  processedItems: number;
  successfulItems: number;
  failedItems: number;
  result?: Record<string, unknown> | null;
};

export type JobOutcome =
  | { status: 'SUCCEEDED'; work: JobWorkResult }
  | { status: 'FAILED'; work: JobWorkResult; errorMessage: string }
  | { status: 'SKIPPED'; reason: JobSkipReason }
  /** Outro worker é dono, ou a janela já teve `SUCCEEDED`. */
  | { status: 'NOT_ACQUIRED' }
  /** Perdeu a posse no meio: **não finaliza e não emite nada**. */
  | { status: 'LOST_LEASE' };

/**
 * Coordenação distribuída dos jobs de §8.8.
 *
 * Concentra o takeover condicional, o heartbeat e a guarda de posse num lugar
 * só porque a alternativa — cada worker cuidando do próprio lease — é como três
 * implementações divergem e a quarta esquece a guarda da conclusão. E a guarda
 * da conclusão é justamente a que, se faltar, produz um buraco **permanente**:
 * `SUCCEEDED` nunca reexecuta.
 */
@Injectable()
export class JobCoordinatorService {
  private readonly logger = new Logger(JobCoordinatorService.name);

  constructor(private readonly jobRuns: JobRunsRepositoryInterface) {}

  windowKey(jobName: SyncJobName, now: Date): string {
    return windowKeyFor(SYNC_JOBS[jobName].cadence, now);
  }

  /**
   * A dependência de §8.8, resolvida por consulta a `JobRun` e não por horário.
   *
   * Ausente ⇒ o chamador registra `SKIPPED` com `UPSTREAM_NOT_READY`, **sem
   * erro**: a cadeia dirigida por evento é o caminho normal, o cron é rede de
   * segurança, e uma rede de segurança que grita a cada passagem deixa de ser
   * lida.
   */
  async upstreamReady(input: {
    jobName: SyncJobName;
    scopeId: string;
    now: Date;
  }): Promise<boolean> {
    const dependsOn = SYNC_JOBS[input.jobName].dependsOn;
    if (!dependsOn) return true;

    return this.jobRuns.hasSucceeded({
      jobName: dependsOn,
      scopeType: SYNC_JOBS[dependsOn].scopeType,
      scopeId: input.scopeId,
      windowKey: this.windowKey(dependsOn, input.now),
    });
  }

  /**
   * Roda `work` sob lease, com heartbeat a `lease/3` e conclusão cercada.
   *
   * O heartbeat que perde a posse **para de bater** e deixa `lost` marcado: o
   * trabalho em curso descobre isso na próxima `stillOwned()` e aborta. Não
   * cancelamos a `Promise` — não dá — mas garantimos que nada do que ela produzir
   * chegue ao banco como conclusão.
   */
  async runUnderLease(
    input: {
      jobName: SyncJobName;
      scopeId: string;
      now: Date;
      correlationId: string | null;
    },
    work: (guard: LeaseGuard) => Promise<JobOutcome>,
  ): Promise<JobOutcome> {
    const definition = SYNC_JOBS[input.jobName];
    const windowKey = this.windowKey(input.jobName, input.now);

    const lease = await this.jobRuns.acquire({
      jobName: input.jobName,
      scopeType: definition.scopeType,
      scopeId: input.scopeId,
      windowKey,
      leaseMinutes: definition.leaseMinutes,
      correlationId: input.correlationId,
    });

    if (!lease) {
      this.logger.debug(
        `job.not_acquired job=${input.jobName} scope=${input.scopeId} window=${windowKey}`,
      );
      return { status: 'NOT_ACQUIRED' };
    }

    let lost = false;
    const beat = setInterval(() => {
      void this.jobRuns
        .heartbeat(lease)
        .then((owned) => {
          if (owned) return;
          lost = true;
          clearInterval(beat);
          this.logger.warn(
            `job.lease_lost job=${input.jobName} scope=${input.scopeId} attempt=${lease.attempt}`,
          );
        })
        .catch(() => undefined);
    }, heartbeatIntervalMs(definition.leaseMinutes));
    // Um heartbeat pendente não pode segurar o processo no shutdown: o lease
    // vence sozinho e outro worker faz takeover, que é o comportamento correto.
    beat.unref?.();

    const guard: LeaseGuard = {
      lease,
      stillOwned: async () => !lost && (await this.jobRuns.heartbeat(lease)),
    };

    const startedAt = Date.now();

    try {
      const outcome = await work(guard);

      if (lost) return { status: 'LOST_LEASE' };

      return await this.finish(lease, outcome, Date.now() - startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `job.failed job=${input.jobName} scope=${input.scopeId}: ${message}`,
      );

      const failure: JobOutcome = {
        status: 'FAILED',
        work: { processedItems: 0, successfulItems: 0, failedItems: 1 },
        errorMessage: message,
      };

      if (lost) return { status: 'LOST_LEASE' };
      return this.finish(lease, failure, Date.now() - startedAt);
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * Escreve o desfecho sob a mesma guarda de posse.
   *
   * Zero linhas afetadas ⇒ outro worker fez takeover enquanto este trabalhava;
   * devolvemos `LOST_LEASE` e **não** propagamos o resultado. Deixar passar
   * marcaria como `SUCCEEDED` uma janela que este processo não fez.
   */
  private async finish(
    lease: JobLease,
    outcome: JobOutcome,
    durationMs: number,
  ): Promise<JobOutcome> {
    if (outcome.status === 'SKIPPED') {
      const owned = await this.jobRuns.skip(lease, outcome.reason);
      return owned ? outcome : { status: 'LOST_LEASE' };
    }

    if (outcome.status !== 'SUCCEEDED' && outcome.status !== 'FAILED') {
      return outcome;
    }

    const owned = await this.jobRuns.complete(lease, {
      status: outcome.status,
      processedItems: outcome.work.processedItems,
      successfulItems: outcome.work.successfulItems,
      failedItems: outcome.work.failedItems,
      durationMs,
      result: outcome.work.result ?? null,
      errorMessage: outcome.status === 'FAILED' ? outcome.errorMessage : null,
    });

    return owned ? outcome : { status: 'LOST_LEASE' };
  }
}
