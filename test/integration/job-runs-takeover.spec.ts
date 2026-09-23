import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { JobRunsPrismaRepository } from '../../src/modules/sync/infrastructure/database/prisma/job-runs-prisma.repository';
import type { JobLease } from '../../src/modules/sync/domain/ports/job-runs.repository';

/**
 * O takeover condicional de §4.7 **contra o Postgres**.
 *
 * Este arquivo existe por um defeito real. A primeira redação do repositório
 * comparava `id = $1::uuid`, e `job_runs.id` é `text` — Prisma mapeia
 * `String @id @default(uuid())` para `TEXT`. O `INSERT` funcionava (converte
 * `uuid` para `text` por assignment cast) e a **conclusão** falhava, isto é: a
 * escrita que fecha a janela, depois de o trabalho inteiro ter sido feito. Nenhum
 * teste unitário pegaria — SQL cru só existe de verdade com banco do outro lado.
 *
 * **Pula quando não há banco alcançável** na máquina de quem não subiu o
 * compose — e **falha** quando o banco é esperado (`REQUIRE_DATABASE`/`CI`).
 * Um teste que falha por ausência de infraestrutura ensina o time a ignorar
 * vermelho; um que pula onde deveria rodar fica verde por ausência, que é o
 * defeito que A2-S9 encontrou em seis arquivos de uma vez.
 */
const SCOPE_ID = 'jobrun-takeover-spec';

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('job-runs-takeover');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await prisma.jobRun.deleteMany({ where: { scopeId: SCOPE_ID } });
  await prisma.$disconnect();
});

async function withDatabase(
  assertion: (
    repo: JobRunsPrismaRepository,
    windowKey: string,
  ) => Promise<void>,
): Promise<void> {
  if (!prisma) {
    console.warn(
      `[job-runs-takeover] pulado — sem banco alcançável (${reason})`,
    );
    return;
  }

  await assertion(
    new JobRunsPrismaRepository(prisma),
    `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function request(windowKey: string) {
  return {
    jobName: 'ads-ingest' as const,
    scopeType: 'AD_ACCOUNT' as const,
    scopeId: SCOPE_ID,
    windowKey,
    leaseMinutes: 30,
    correlationId: 'spec',
  };
}

const DONE = {
  status: 'SUCCEEDED' as const,
  processedItems: 3,
  successfulItems: 3,
  failedItems: 0,
  durationMs: 42,
  result: { ok: true },
};

describe('takeover condicional de JobRun contra o banco (§4.7)', () => {
  it('lease vivo impede a segunda aquisição', async () => {
    await withDatabase(async (repo, windowKey) => {
      const first = await repo.acquire(request(windowKey));
      expect(first?.attempt).toBe(1);
      expect(await repo.acquire(request(windowKey))).toBeNull();
    });
  });

  it('heartbeat e conclusão só valem para quem tem o attempt corrente (⊕14)', async () => {
    await withDatabase(async (repo, windowKey) => {
      const lease = (await repo.acquire(request(windowKey))) as JobLease;
      const zombie: JobLease = { ...lease, attempt: lease.attempt + 90 };

      expect(await repo.heartbeat(lease)).toBe(true);
      expect(await repo.heartbeat(zombie)).toBe(false);
      // A escrita destrutiva: um worker zumbi marcaria como `SUCCEEDED` uma
      // janela que não fez, e `SUCCEEDED` nunca reexecuta.
      expect(await repo.complete(zombie, DONE)).toBe(false);
      expect(await repo.complete(lease, DONE)).toBe(true);
    });
  });

  it('SUCCEEDED nunca reexecuta', async () => {
    await withDatabase(async (repo, windowKey) => {
      const lease = (await repo.acquire(request(windowKey))) as JobLease;
      await repo.complete(lease, DONE);

      expect(await repo.acquire(request(windowKey))).toBeNull();
      expect(await repo.hasSucceeded(request(windowKey))).toBe(true);
    });
  });

  it('FAILED é retomável, com attempt incrementado', async () => {
    await withDatabase(async (repo, windowKey) => {
      const lease = (await repo.acquire(request(windowKey))) as JobLease;
      await repo.complete(lease, {
        ...DONE,
        status: 'FAILED',
        errorMessage: 'plataforma fora do ar',
      });

      const retaken = await repo.acquire(request(windowKey));
      expect(retaken?.attempt).toBe(2);
    });
  });

  it('SKIPPED é retomável dentro da mesma janela (⊕11)', async () => {
    await withDatabase(async (repo, windowKey) => {
      const lease = (await repo.acquire(request(windowKey))) as JobLease;
      expect(await repo.skip(lease, 'UPSTREAM_NOT_READY')).toBe(true);

      // Se o motivo desaparecer dentro da mesma janela — o upstream termina, a
      // integração reconecta —, `DO NOTHING` deixaria a janela sem rodar nunca.
      const retaken = await repo.acquire(request(windowKey));
      expect(retaken?.attempt).toBe(2);
    });
  });

  it('lease vencido é retomável por outro worker', async () => {
    await withDatabase(async (repo, windowKey) => {
      const lease = (await repo.acquire(request(windowKey))) as JobLease;

      await prisma!.jobRun.update({
        where: { id: lease.id },
        data: { leaseExpiresAt: new Date(Date.now() - 60_000) },
      });

      const retaken = await repo.acquire(request(windowKey));
      expect(retaken?.attempt).toBe(2);
      // E o dono anterior perde a posse na hora, inclusive para concluir.
      expect(await repo.complete(lease, DONE)).toBe(false);
    });
  });
});
