import { JobCoordinatorService } from './job-coordinator.service';
import {
  JobCompletion,
  JobLease,
  JobRunsRepositoryInterface,
} from '../../domain/ports/job-runs.repository';
import {
  JobScopeType,
  JobSkipReason,
  SyncJobName,
} from '../../domain/job-schedule';

/**
 * Um `job_runs` em memória com **a mesma semântica do SQL** de §4.7.
 *
 * O ponto de escrevê-lo em vez de mockar `acquire` é que o comportamento sob
 * teste é a interação entre as três operações: quem cede a janela, quem
 * incrementa `attempt` e o que acontece com quem perdeu a posse. Um mock
 * devolvendo `null` provaria só que o coordenador lê o retorno.
 */
class InMemoryJobRuns extends JobRunsRepositoryInterface {
  private readonly rows = new Map<
    string,
    {
      id: string;
      attempt: number;
      status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
      leaseExpiresAt: number;
      completion?: JobCompletion;
    }
  >();

  now = Date.now();

  private key(input: {
    jobName: string;
    scopeType: string;
    scopeId: string;
    windowKey: string;
  }): string {
    return `${input.jobName}|${input.scopeType}|${input.scopeId}|${input.windowKey}`;
  }

  async acquire(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
    leaseMinutes: number;
    correlationId: string | null;
  }): Promise<JobLease | null> {
    const key = this.key(input);
    const existing = this.rows.get(key);
    const leaseExpiresAt = this.now + input.leaseMinutes * 60_000;

    if (!existing) {
      this.rows.set(key, {
        id: key,
        attempt: 1,
        status: 'RUNNING',
        leaseExpiresAt,
      });
      return { ...input, id: key, attempt: 1 };
    }

    const retakeable =
      existing.status === 'SKIPPED' ||
      existing.status === 'FAILED' ||
      (existing.status === 'RUNNING' && existing.leaseExpiresAt < this.now);

    // `SUCCEEDED` nunca reexecuta — é onde a idempotência de janela importa.
    if (!retakeable) return null;

    existing.attempt += 1;
    existing.status = 'RUNNING';
    existing.leaseExpiresAt = leaseExpiresAt;

    return { ...input, id: key, attempt: existing.attempt };
  }

  async heartbeat(lease: JobLease): Promise<boolean> {
    const row = this.rows.get(lease.id);
    if (!row || row.attempt !== lease.attempt || row.status !== 'RUNNING') {
      return false;
    }
    row.leaseExpiresAt = this.now + lease.leaseMinutes * 60_000;
    return true;
  }

  async complete(lease: JobLease, completion: JobCompletion): Promise<boolean> {
    const row = this.rows.get(lease.id);
    if (!row || row.attempt !== lease.attempt || row.status !== 'RUNNING') {
      return false;
    }
    row.status = completion.status;
    row.completion = completion;
    return true;
  }

  async skip(lease: JobLease, reason: JobSkipReason): Promise<boolean> {
    const row = this.rows.get(lease.id);
    if (!row || row.attempt !== lease.attempt || row.status !== 'RUNNING') {
      return false;
    }
    row.status = 'SKIPPED';
    row.completion = {
      status: 'FAILED',
      processedItems: 0,
      successfulItems: 0,
      failedItems: 0,
      durationMs: 0,
      errorMessage: reason,
    };
    return true;
  }

  async hasSucceeded(input: {
    jobName: SyncJobName;
    scopeType: JobScopeType;
    scopeId: string;
    windowKey: string;
  }): Promise<boolean> {
    return this.rows.get(this.key(input))?.status === 'SUCCEEDED';
  }

  async listWindowKeysSince(input: {
    jobName: SyncJobName;
  }): Promise<string[]> {
    // As linhas moram numa chave composta `job|escopo|id|janela`; a janela é o
    // último segmento.
    return [
      ...new Set(
        [...this.rows.keys()]
          .filter((key) => key.startsWith(`${input.jobName}|`))
          .map((key) => key.split('|')[3]),
      ),
    ];
  }

  statusOf(key: string) {
    return this.rows.get(key)?.status;
  }
}

const WORK = {
  processedItems: 1,
  successfulItems: 1,
  failedItems: 0,
};

describe('coordenação de janela (§8.8, ⊕11, ⊕14)', () => {
  let repo: InMemoryJobRuns;
  let coordinator: JobCoordinatorService;

  beforeEach(() => {
    repo = new InMemoryJobRuns();
    coordinator = new JobCoordinatorService(repo);
  });

  const request = {
    jobName: 'ads-ingest' as const,
    scopeId: 'acc-1',
    now: new Date('2026-08-01T14:20:00Z'),
    correlationId: 'corr-1',
  };

  it('a segunda tentativa da mesma janela não adquire nada', async () => {
    await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));

    const second = await coordinator.runUnderLease(request, async () => {
      throw new Error('não deveria executar');
    });

    expect(second.status).toBe('NOT_ACQUIRED');
  });

  it('janela SKIPPED é retomada dentro da mesma janela (⊕11)', async () => {
    // O cenário é real: a integração reconecta às 14h15, o upstream termina, a
    // flag é ligada. Com `ON CONFLICT DO NOTHING`, a janela nunca rodaria — o
    // status que existe para melhorar observabilidade criaria um buraco.
    const skipped = await coordinator.runUnderLease(request, async () => ({
      status: 'SKIPPED',
      reason: 'UPSTREAM_NOT_READY',
    }));
    expect(skipped.status).toBe('SKIPPED');

    const retried = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));

    expect(retried.status).toBe('SUCCEEDED');
  });

  it('janela FAILED é retomada; janela SUCCEEDED nunca é', async () => {
    await coordinator.runUnderLease(request, async () => ({
      status: 'FAILED',
      work: WORK,
      errorMessage: 'plataforma fora do ar',
    }));

    const retried = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));
    expect(retried.status).toBe('SUCCEEDED');

    const third = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));
    expect(third.status).toBe('NOT_ACQUIRED');
  });

  it('lease vivo de outro worker impede a aquisição', async () => {
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = coordinator.runUnderLease(request, async () => {
      await blocked;
      return { status: 'SUCCEEDED', work: WORK };
    });

    const second = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));

    expect(second.status).toBe('NOT_ACQUIRED');

    release!();
    await first;
  });

  it('worker que perdeu a posse NÃO conclui a janela (⊕14)', async () => {
    // O cenário destrutivo: worker congelado às 14h03 volta às 14h22, depois de
    // outro ter feito takeover. Sem o token de cerca, ele marcaria como
    // `SUCCEEDED` uma janela que não fez — e `SUCCEEDED` nunca reexecuta, então
    // o buraco seria permanente.
    const zombie = await repo.acquire({
      jobName: 'ads-ingest',
      scopeType: 'AD_ACCOUNT',
      scopeId: 'acc-1',
      windowKey: coordinator.windowKey('ads-ingest', request.now),
      leaseMinutes: 30,
      correlationId: 'corr-zumbi',
    });
    expect(zombie).not.toBeNull();

    // O lease vence e outro worker faz takeover, incrementando `attempt`.
    repo.now += 31 * 60_000;
    const takeover = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));
    expect(takeover.status).toBe('SUCCEEDED');

    // O zumbi tenta concluir com o `attempt` antigo: zero linhas afetadas.
    const concluded = await repo.complete(zombie!, {
      status: 'SUCCEEDED',
      processedItems: 0,
      successfulItems: 0,
      failedItems: 0,
      durationMs: 1,
    });

    expect(concluded).toBe(false);
    expect(await repo.heartbeat(zombie!)).toBe(false);
  });

  it('exceção no trabalho fecha a janela como FAILED, e ela volta a ser retomável', async () => {
    const outcome = await coordinator.runUnderLease(request, async () => {
      throw new Error('timeout da plataforma');
    });

    expect(outcome).toMatchObject({
      status: 'FAILED',
      errorMessage: 'timeout da plataforma',
    });

    const retried = await coordinator.runUnderLease(request, async () => ({
      status: 'SUCCEEDED',
      work: WORK,
    }));
    expect(retried.status).toBe('SUCCEEDED');
  });

  it('a dependência de §8.8 é resolvida por consulta, não por horário', async () => {
    // `ads-ingest` não declara upstream, então está sempre pronto. Um job que
    // declarasse dependeria de o upstream ter `SUCCEEDED` **naquela janela**.
    await expect(
      coordinator.upstreamReady({
        jobName: 'ads-ingest',
        scopeId: 'acc-1',
        now: request.now,
      }),
    ).resolves.toBe(true);
  });
});
