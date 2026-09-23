/* eslint-disable no-console */
/**
 * Gate de desempenho de A2-S7 (§17.2): **latência de execução de ação,
 * enfileirar → plataforma, p95 < 10 s**.
 *
 * Declarado em A2-S7 e nunca medido — atravessou S8 e S9 como gate aberto.
 *
 * ## O que ele mede, e por que a plataforma é stubada
 *
 * O orçamento de 10 s cobre o caminho **até** a plataforma. Dele, o que é nosso
 * são duas coisas:
 *
 * - **Aceitação** (`202`): revalidação, guardas de P5, I2, transação de
 *   enfileiramento. É o que o usuário espera olhando a tela.
 * - **Execução**: carregar a ação, reconferir o kill switch, `markRunning`,
 *   ler o estado anterior, escrever, liquidar, auditar, emitir.
 *
 * A latência da Meta **não é nossa para otimizar** e varia por região, horário e
 * conta. Medi-la aqui produziria um número que oscila sem que o código mude — e
 * um gate que oscila sozinho é um gate que ninguém investiga. O stub isola o
 * overhead que responde a decisão de engenharia; a folga contra os 10 s diz
 * quanto sobra para a rede.
 *
 * ## Como rodar
 *
 *   docker compose up -d
 *   pnpm seed:ads-v2
 *   pnpm bench:write
 */
// **Primeiro import, sempre.** `ConfigModule` lê o ambiente no import do
// decorador — ver o arquivo, que explica por que isto não é um `beforeAll`.
import './support/bench-env';
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/infrastructure/database/prisma/prisma.service';
import { ExecuteActionUseCase } from '../src/modules/platform-actions/application/use-cases/execute-action.usecase';
import { PlatformActionsWorker } from '../src/modules/platform-actions/infrastructure/queues/platform-actions.worker';
import { PlatformActionsDispatcher } from '../src/modules/platform-actions/infrastructure/queues/platform-actions.dispatcher';
import { AdActionGateway } from '../src/modules/platform-actions/domain/ports/ad-action.gateway';
import { PlatformCredentialProvider } from '../src/modules/platform-clients/domain/ports/platform-credential.provider';
import { InlineQueue, testJobContext } from '../test/support/inline-queue';

const ITERATIONS = 40;
/** §17.2 — enfileirar → plataforma. */
const P95_BUDGET_MS = 10_000;
/**
 * O que o usuário espera pelo `202`. Não está em §17.2 e é o número que a tela
 * sente: acima disto o clique "trava" mesmo com a escrita saindo rápido depois.
 */
const ACCEPT_BUDGET_MS = 1_000;

const SUFFIX = 'bench-write';

/** A plataforma, sem rede. Aceita e devolve o alvo inalterado. */
const gatewayStub = {
  platform: 'META' as const,
  capabilities: () => [
    {
      type: 'PAUSE_AD' as const,
      supported: true,
      reversible: true,
      requiresRecreate: false,
      createsEntity: false,
      validationDepth: 'LOCAL_ONLY' as const,
    },
  ],
  validate: async () => ({ valid: true, failures: [] }),
  observe: async () => ({ status: 'ACTIVE', raw: {} }),
  execute: async () => ({
    status: 'SUCCEEDED' as const,
    raw: {},
    platformEntityId: null,
  }),
  revert: async () => ({ status: 'SUCCEEDED' as const, raw: {} }),
};

async function main(): Promise<void> {
  const queue = new InlineQueue();

  /**
   * **Despacho diferido**, e é o que torna os dois números distintos.
   *
   * Com a fila executando em processo, `execute()` já inclui o trabalho do
   * worker — e a primeira redação deste script reportou o **mesmo** número sob
   * dois rótulos, que parece medição e não é. Aqui o dispatcher só registra; o
   * worker roda depois, cronometrado à parte.
   */
  const app = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PlatformActionsDispatcher)
    .useValue({
      perform: (data: unknown) => {
        queue.dispatched.push({ name: 'perform-action', data });
        return Promise.resolve();
      },
      performLater: (data: unknown) => {
        queue.dispatched.push({ name: 'perform-action', data });
        return Promise.resolve();
      },
      verify: () => Promise.resolve(),
      reap: () => Promise.resolve(),
    })
    .overrideProvider(AdActionGateway)
    .useValue([gatewayStub])
    .overrideProvider(PlatformCredentialProvider)
    .useValue({
      resolveByIntegration: async () => ({ accessToken: 'bench-token' }),
      resolve: async () => ({ accessToken: 'bench-token' }),
      onRefreshed: async () => undefined,
    })
    .compile();

  await app.init();

  const prisma = app.get(PrismaService);
  const execute = app.get(ExecuteActionUseCase);
  const worker = app.get(PlatformActionsWorker);

  const fixture = await seed(prisma);
  if (!fixture) {
    console.error('Sem organização/integração no banco. Rode: pnpm seed:ads-v2');
    await app.close();
    process.exit(1);
  }

  const accepted: number[] = [];
  const settled: number[] = [];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const adId = fixture.adIds[index % fixture.adIds.length];

    /**
     * **Cada iteração num alvo diferente**, e por quê: I2 recusa uma segunda
     * escrita sobre o mesmo alvo enquanto a primeira está em voo. Repetir o
     * mesmo anúncio mediria o caminho da recusa — que é rápido, e não é o que o
     * gate protege.
     */
    queue.reset();
    const startedAt = process.hrtime.bigint();

    await execute.execute({
      organizationId: fixture.organizationId,
      accountId: fixture.accountId,
      adId,
      body: {
        type: 'PAUSE_AD',
        parameters: { schemaVersion: 1, adId },
        dryRun: false,
      },
      idempotencyKey: `${SUFFIX}-${index}-${Date.now()}`,
      correlationId: `${SUFFIX}-corr`,
      ipAddress: null,
      userAgent: null,
    });

    // ① Aceitação: o que o usuário espera pelo `202`.
    const acceptedAt = process.hrtime.bigint();
    accepted.push(Number(acceptedAt - startedAt) / 1_000_000);

    const job = queue.payloadsOf<{ executionId: string; attempt: number }>(
      'perform-action',
    )[0];

    if (!job) throw new Error('Nada foi enfileirado: a guarda recusou a escrita');

    // ② Execução: carregar, reconferir kill switch, escrever, liquidar, auditar.
    await worker.handlePerform({
      data: { ...job, ctx: testJobContext() },
    } as never);

    settled.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);

    await resetTarget(prisma, adId);
  }

  report('② Enfileirar → plataforma (§17.2)', settled, P95_BUDGET_MS);
  report('① Aceitação, o que a tela sente', accepted, ACCEPT_BUDGET_MS);

  await cleanup(prisma);
  await app.close();
}

function report(label: string, samples: number[], budgetMs: number): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

  const p50 = at(0.5);
  const p95 = at(0.95);
  const p99 = at(0.99);

  console.log(`\n${label}`);
  console.log(`  amostras   ${sorted.length}`);
  console.log(`  p50        ${p50.toFixed(1)} ms`);
  console.log(`  p95        ${p95.toFixed(1)} ms`);
  console.log(`  p99        ${p99.toFixed(1)} ms`);
  console.log(`  orçamento  ${budgetMs} ms`);
  console.log(
    `  veredito   ${p95 < budgetMs ? 'PASSA' : 'FALHA'} (${((p95 / budgetMs) * 100).toFixed(1)}% do orçamento)`,
  );
}

type Fixture = { organizationId: string; accountId: string; adIds: string[] };

async function seed(prisma: PrismaService): Promise<Fixture | null> {
  await cleanup(prisma);

  const organization = await prisma.organization.findFirst({
    select: { id: true, ownerId: true },
  });
  if (!organization) return null;

  const integration = await prisma.integration.findFirst({
    where: { organizationId: organization.id },
    select: { id: true },
  });
  if (!integration) return null;

  await prisma.organization.update({
    where: { id: organization.id },
    data: { actionsEnabled: true },
  });

  await prisma.integrationWriteConsent.deleteMany({
    where: { integrationId: integration.id },
  });
  await prisma.integrationWriteConsent.create({
    data: {
      integrationId: integration.id,
      organizationId: organization.id,
      grantedByAccountId: organization.ownerId,
      consentedActionTypes: ['PAUSE_AD'],
    },
  });

  const adAccount = await prisma.adAccount.create({
    data: {
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: 'META',
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta do benchmark',
      integrationId: integration.id,
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      id: `${SUFFIX}-campaign`,
      adAccountId: adAccount.id,
      organizationId: organization.id,
      platform: 'META',
      integrationId: integration.id,
      externalCampaignId: `${SUFFIX}-camp`,
      name: 'Campanha do benchmark',
      currency: 'BRL',
    },
  });

  const adIds: string[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const id = `${SUFFIX}-ad-${index}`;
    await prisma.ad.create({
      data: {
        id,
        accountId: organization.ownerId,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        integrationId: integration.id,
        platform: 'META',
        externalAdId: `${SUFFIX}-ext-${index}`,
        campaignId: campaign.id,
        lineageId: id,
        name: `Anúncio ${index}`,
        observedStatus: 'ACTIVE',
        syncState: 'IN_SYNC',
        dataMaturity: 'MATURE',
      },
    });
    adIds.push(id);
  }

  return {
    organizationId: organization.id,
    accountId: organization.ownerId,
    adIds,
  };
}

/** Devolve o anúncio a `IN_SYNC`: I2 recusaria a próxima escrita sobre ele. */
async function resetTarget(prisma: PrismaService, adId: string): Promise<void> {
  await prisma.ad.update({
    where: { id: adId },
    data: { syncState: 'IN_SYNC', desiredStatus: null, desiredStatusSetAt: null },
  });
}

async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.actionExecution.deleteMany({
    where: { action: { adId: { startsWith: SUFFIX } } },
  });
  await prisma.adAction.deleteMany({ where: { adId: { startsWith: SUFFIX } } });
  await prisma.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await prisma.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await prisma.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
