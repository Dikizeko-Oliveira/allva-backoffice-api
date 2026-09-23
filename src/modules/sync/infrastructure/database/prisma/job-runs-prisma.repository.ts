import { Injectable, Logger } from '@nestjs/common';
import {
  JobCompletion,
  JobLease,
  JobRunsRepositoryInterface,
} from 'src/modules/sync/domain/ports/job-runs.repository';
import {
  JobScopeType,
  JobSkipReason,
  SyncJobName,
} from 'src/modules/sync/domain/job-schedule';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type AcquiredRow = { id: string; attempt: number };

/**
 * `job_runs.id` é **`text`**, não `uuid`.
 *
 * Prisma mapeia `String @id @default(uuid())` para `TEXT`, e a primeira redação
 * daqui comparava `id = $1::uuid` — sintaxe válida, coluna errada, e o Postgres
 * recusa com `operator does not exist: text = uuid`. O erro não apareceu na
 * aquisição (o `INSERT` converte `uuid` para `text` por assignment cast), só na
 * **conclusão** — isto é, na escrita que fecha a janela, depois de o trabalho
 * inteiro ter sido feito. Foi encontrado rodando o repositório contra o banco de
 * desenvolvimento; nenhum teste unitário o pegaria, porque o SQL cru só existe
 * de verdade quando há Postgres do outro lado.
 */

/**
 * O takeover condicional de §4.7, em SQL cru — e é cru por necessidade.
 *
 * `prisma.upsert` faz `SELECT` e então `INSERT`/`UPDATE`, o que abre a janela de
 * corrida que este mecanismo existe para fechar; e não há como expressar a
 * cláusula `WHERE` do `DO UPDATE`, que é onde mora a regra inteira: só cede a
 * janela quem está `SKIPPED`, `FAILED` ou com lease vencido. **`SUCCEEDED` nunca
 * reexecuta.**
 */
@Injectable()
export class JobRunsPrismaRepository extends JobRunsRepositoryInterface {
  private readonly logger = new Logger(JobRunsPrismaRepository.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async acquire(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
    leaseMinutes: number;
    correlationId: string | null;
  }): Promise<JobLease | null> {
    const lease = `${input.leaseMinutes} minutes`;

    const rows = await this.prisma.$queryRaw<AcquiredRow[]>`
      INSERT INTO job_runs (
        id, job_name, scope_type, scope_id, window_key,
        status, started_at, lease_expires_at, correlation_id
      )
      VALUES (
        gen_random_uuid()::text, ${input.jobName}, ${input.scopeType}::"JobScopeType",
        ${input.scopeId}, ${input.windowKey},
        'RUNNING', now(), now() + ${lease}::interval, ${input.correlationId}
      )
      ON CONFLICT (job_name, scope_type, scope_id, window_key) DO UPDATE
         SET status = 'RUNNING',
             started_at = now(),
             attempt = job_runs.attempt + 1,
             lease_expires_at = now() + ${lease}::interval,
             skip_reason = NULL,
             finished_at = NULL,
             error_message = NULL,
             correlation_id = ${input.correlationId}
       WHERE job_runs.status IN ('SKIPPED', 'FAILED')
          OR (job_runs.status = 'RUNNING' AND job_runs.lease_expires_at < now())
      RETURNING id, attempt
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      attempt: Number(row.attempt),
      jobName: input.jobName,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      windowKey: input.windowKey,
      leaseMinutes: input.leaseMinutes,
    };
  }

  /**
   * Renovação sob a **mesma** guarda da conclusão (⊕14). `attempt` é o token de
   * cerca: um worker que perdeu a janela para um takeover tem `attempt` antigo e
   * não afeta nenhuma linha.
   */
  async heartbeat(lease: JobLease): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE job_runs
         SET lease_expires_at = now() + ${`${lease.leaseMinutes} minutes`}::interval
       WHERE id = ${lease.id}
         AND attempt = ${lease.attempt}
         AND status = 'RUNNING'
    `;

    return affected > 0;
  }

  /**
   * A escrita destrutiva. Zero linhas ⇒ o worker perdeu a posse e **aborta**:
   * não finaliza, não escreve resultado, não emite evento de conclusão.
   *
   * Um worker congelado às 14h03 que volta às 14h22, depois de outro ter feito
   * takeover, marcaria a janela como `SUCCEEDED` com contadores zerados — e
   * `SUCCEEDED` nunca reexecuta, então o buraco seria permanente.
   */
  async complete(lease: JobLease, completion: JobCompletion): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE job_runs
         SET status = ${completion.status}::"JobRunStatus",
             finished_at = now(),
             duration_ms = ${completion.durationMs},
             processed_items = ${completion.processedItems},
             successful_items = ${completion.successfulItems},
             failed_items = ${completion.failedItems},
             result = ${
               completion.result ? JSON.stringify(completion.result) : null
             }::jsonb,
             error_message = ${completion.errorMessage ?? null}
       WHERE id = ${lease.id}
         AND attempt = ${lease.attempt}
         AND status = 'RUNNING'
    `;

    if (affected === 0) {
      this.logger.warn(
        `job.ownership_lost job=${lease.jobName} scope=${lease.scopeId} ` +
          `window=${lease.windowKey} attempt=${lease.attempt} — conclusão abortada`,
      );
    }

    return affected > 0;
  }

  async skip(lease: JobLease, reason: JobSkipReason): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE job_runs
         SET status = 'SKIPPED',
             skip_reason = ${reason},
             finished_at = now()
       WHERE id = ${lease.id}
         AND attempt = ${lease.attempt}
         AND status = 'RUNNING'
    `;

    return affected > 0;
  }

  async listWindowKeysSince(input: {
    jobName: SyncJobName;
    since: Date;
  }): Promise<string[]> {
    const rows = await this.prisma.jobRun.findMany({
      where: { jobName: input.jobName, startedAt: { gte: input.since } },
      select: { windowKey: true },
      distinct: ['windowKey'],
    });

    return rows.map((row) => row.windowKey);
  }

  async hasSucceeded(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
  }): Promise<boolean> {
    const found = await this.prisma.jobRun.findFirst({
      where: {
        jobName: input.jobName,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        windowKey: input.windowKey,
        status: 'SUCCEEDED',
      },
      select: { id: true },
    });

    return found !== null;
  }
}
