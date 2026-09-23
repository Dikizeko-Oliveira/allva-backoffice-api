import { JobScopeType, JobSkipReason, SyncJobName } from '../job-schedule';

/**
 * Coordenação distribuída dos jobs (§4.7, §8.8; achados A11, ⊕11, ⊕12, ⊕14).
 *
 * A unique `(job, escopo, janela)` é o mecanismo — **mas `DO NOTHING` não
 * serve**. Uma linha `SKIPPED` ocupa o slot. Se o motivo desaparecer dentro da
 * mesma janela — a integração reconecta às 14h15, o upstream termina, a flag é
 * ligada —, a próxima tentativa bateria no conflito, não faria nada, e **a
 * janela nunca rodaria**. O status que existe para melhorar observabilidade
 * criaria um buraco silencioso de processamento.
 */

export type JobLease = {
  id: string;
  /**
   * Token de cerca (fencing token), monotônico por linha.
   *
   * É o que impede um worker zumbi de marcar como `SUCCEEDED` uma janela que
   * não fez. Um worker congelado às 14h03 que volta às 14h22, depois de outro
   * ter feito takeover, finalizaria a janela com contadores zerados — e
   * `SUCCEEDED` **nunca reexecuta**, então o buraco seria permanente.
   */
  attempt: number;
  jobName: SyncJobName;
  scopeType: JobScopeType;
  scopeId: string;
  windowKey: string;
  leaseMinutes: number;
};

export type JobCompletion = {
  status: 'SUCCEEDED' | 'FAILED';
  processedItems: number;
  successfulItems: number;
  failedItems: number;
  durationMs: number;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
};

export abstract class JobRunsRepositoryInterface {
  /**
   * Takeover condicional. Devolve `null` quando **outro worker é dono** (lease
   * vivo) ou quando a janela já teve `SUCCEEDED`.
   *
   * ```sql
   * INSERT ... ON CONFLICT (job_name, scope_type, scope_id, window_key) DO UPDATE
   *    SET status='RUNNING', attempt = job_runs.attempt + 1, ...
   *  WHERE job_runs.status IN ('SKIPPED','FAILED')
   *     OR (job_runs.status='RUNNING' AND job_runs.lease_expires_at < now())
   * ```
   *
   * Preserva a idempotência exatamente onde ela importa e libera o que é
   * legitimamente retentável.
   */
  abstract acquire(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
    leaseMinutes: number;
    correlationId: string | null;
  }): Promise<JobLease | null>;

  /**
   * Renova o lease. **Mesma guarda de posse da conclusão** (⊕14): renovar é o
   * menos perigoso que um zumbi faz, mas verificar só na renovação deixaria o
   * caminho destrutivo sem cerca.
   *
   * `false` ⇒ perdeu a posse; quem chamou aborta.
   */
  abstract heartbeat(lease: JobLease): Promise<boolean>;

  /**
   * Conclui a janela sob a mesma guarda. Zero linhas afetadas ⇒ **o worker
   * perdeu a posse e aborta imediatamente**: não finaliza, não escreve
   * resultado, não emite evento de conclusão.
   */
  abstract complete(
    lease: JobLease,
    completion: JobCompletion,
  ): Promise<boolean>;

  /** Marca a janela como pulada, com razão do vocabulário fechado. */
  abstract skip(lease: JobLease, reason: JobSkipReason): Promise<boolean>;

  /**
   * A dependência de §8.8, resolvida por consulta e não por horário.
   *
   * *"'Após o ingest' não é executável enquanto for uma palavra."* Ausente ⇒ o
   * chamador registra `SKIPPED` com `UPSTREAM_NOT_READY`, **sem erro**: a cadeia
   * dirigida por evento é o caminho normal e o cron é rede de segurança.
   */
  abstract hasSucceeded(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
  }): Promise<boolean>;

  /**
   * As janelas **distintas** que este job registrou desde `since`, em qualquer
   * escopo e com qualquer status.
   *
   * Distintas e sem escopo porque a pergunta que ela responde é sobre o
   * agendador, não sobre uma conta: um cron que não dispara não deixa linha
   * para escopo nenhum. Qualquer status serve — `SKIPPED` é decisão registrada,
   * e o que o detector procura é a janela sem decisão alguma.
   */
  abstract listWindowKeysSince(input: {
    jobName: SyncJobName;
    since: Date;
  }): Promise<string[]>;
}
