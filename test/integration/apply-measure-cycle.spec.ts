// **Primeiro import, e a ordem é a razão de ele existir.** `ConfigModule` lê o
// ambiente no import do decorador, não na instanciação — ver o arquivo.
import '../support/enable-write-path';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { ApplyRecommendationPlanUseCase } from '../../src/modules/platform-actions/application/use-cases/apply-recommendation-plan.usecase';
import { MeasureOutcomesService } from '../../src/modules/recommendations/application/services/measure-outcomes.service';
import { PlatformActionsDispatcher } from '../../src/modules/platform-actions/infrastructure/queues/platform-actions.dispatcher';
import { PlatformActionsWorker } from '../../src/modules/platform-actions/infrastructure/queues/platform-actions.worker';
import { AdActionGateway } from '../../src/modules/platform-actions/domain/ports/ad-action.gateway';
import { PlatformCredentialProvider } from '../../src/modules/platform-clients/domain/ports/platform-credential.provider';
import { InlineQueue, testJobContext } from '../support/inline-queue';
import { requireDatabaseWhenExpected } from '../support/database';

/**
 * **O gate E2E que A2-S7, A2-S8 e A2-S9 declararam e nenhum fechou.**
 *
 * > *"E2E completo: detectar → recomendar → aplicar → verificar → resolver →
 * > **medir**."*
 *
 * Este arquivo cobre a metade que A2-S9 possui — **aplicar → resolver → medir** —
 * contra o `AppModule` real, o Postgres real e uma fila em processo. A metade de
 * cima (detectar → recomendar) tem cobertura própria em `detect-waste.service` e
 * `generate-recommendations.service`; o que nunca teve verificação era a
 * costura, e era exatamente ali que o defeito estava.
 *
 * **O defeito que ele teria pego.** Entre A2-S6 e A2-S8, `capturePreWindow` não
 * tinha chamador, nada marcava `APPLIED` e `ActionEnqueueService` gravava
 * `origin: 'USER_DIRECT'` fixo. `tsc` não reclama de método não chamado, e
 * nenhuma suíte de unidade monta a cadeia. Este teste falha na primeira linha
 * dela que se romper.
 *
 * **A plataforma é stubada de propósito.** O que se verifica é a nossa cadeia:
 * guardas de P5, I2, transação de `appliedAt`, resolução de achados, medição
 * sobre a linhagem. Uma chamada real à Meta acrescentaria latência de rede e
 * uma dependência de credencial — e nenhuma asserção.
 */

const SUFFIX = 'e2e-cycle-spec';

jest.setTimeout(120_000);

let app: TestingModule | null = null;
let prisma: PrismaService | null = null;
let queue: InlineQueue;
let skipReason = '';

/**
 * O gateway que a plataforma seria. Aceita a escrita e devolve o alvo inalterado.
 *
 * **`capabilities()` declara `PAUSE_AD`, e não uma lista vazia.** A primeira
 * redação devolvia `[]`, e a recusa foi `ACTION_UNSUPPORTED` — o registry
 * resolve disponibilidade pela capability, não pela existência do gateway.
 * Um stub que não declara o que suporta testa o caminho da recusa, que já tem
 * cobertura própria.
 */
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
    raw: { ok: true },
    platformEntityId: null,
  }),
  revert: async () => ({ status: 'SUCCEEDED' as const, raw: {} }),
};

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('apply-measure-cycle');
  if (!probe.reachable) {
    skipReason = probe.reason;
    return;
  }

  queue = new InlineQueue();

  app = await Test.createTestingModule({ imports: [AppModule] })
    /**
     * A fila em processo. O `perform` do worker roda **dentro** da chamada que
     * o enfileirou, então o efeito do passo N está visível no passo N+1 sem
     * `setTimeout` — que é o que torna teste de fila lento e intermitente.
     */
    /**
     * **O dispatcher não injeta o worker** — seria ciclo de DI: o worker já
     * depende do dispatcher. A primeira redação fez isso e a suíte **pendurou**
     * na resolução, sem mensagem. O handler é ligado depois do boot, com o
     * worker já resolvido, e é o que quebra o ciclo.
     */
    .overrideProvider(PlatformActionsDispatcher)
    .useValue({
      perform: (data: unknown) => queue.dispatch('perform-action', data),
      performLater: (data: unknown) => queue.dispatch('perform-action', data),
      /**
       * A escada é **registrada e não executada**. Ela lê a plataforma, e o
       * stub sempre devolveria `ACTIVE` — confirmaria uma pausa que não
       * aconteceu. O que este teste afirma é que ela foi agendada.
       */
      verify: (data: unknown) => {
        queue.dispatched.push({ name: 'verify-action', data });
        return Promise.resolve();
      },
      reap: () => Promise.resolve(),
    })
    .overrideProvider(AdActionGateway)
    .useValue([gatewayStub])
    .overrideProvider(PlatformCredentialProvider)
    .useValue({
      resolveByIntegration: async () => ({ accessToken: 'stub-token' }),
      resolve: async () => ({ accessToken: 'stub-token' }),
      onRefreshed: async () => undefined,
    })
    .compile();

  await app.init();
  prisma = app.get(PrismaService);

  /**
   * O worker, **depois** do boot. É ele que roteia o desfecho — `RETRY`
   * reenfileira, `VERIFY` agenda a escada, `SETTLED` pede releitura ao `sync` —
   * e ligar o serviço no lugar dele pularia justamente essa decisão.
   */
  const worker = app.get(PlatformActionsWorker);
  queue.on<{ executionId: string; attempt: number }>(
    'perform-action',
    async (data) =>
      worker.handlePerform({
        data: { ...data, ctx: testJobContext() },
      } as never),
  );
}, 120_000);

afterAll(async () => {
  if (prisma) await cleanup(prisma);
  await app?.close();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.recommendationOutcome.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.actionExecution.deleteMany({
    where: { action: { adId: { startsWith: SUFFIX } } },
  });
  await client.recommendationWasteItem.deleteMany({
    where: { wasteItem: { adId: { startsWith: SUFFIX } } },
  });
  await client.adAction.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.recommendation.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.wasteItem.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.adMetricSnapshot.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adSet.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: as tabelas acima referenciam a organização do inquilino.
  await removeTenant(client, SUFFIX);
}

type Fixture = {
  organizationId: string;
  accountId: string;
  adId: string;
  recommendationId: string;
  wasteItemId: string;
};

/**
 * Um anúncio que gastou e não converteu, com o achado e o plano já gravados.
 *
 * A detecção e a geração não são reexecutadas aqui: elas têm suíte própria, e
 * repeti-las tornaria este teste dependente dos limiares do `DetectorProfile` —
 * que mudam por calibração, sem que a costura mude. O que este arquivo verifica
 * começa no clique do usuário.
 */
async function seed(client: PrismaService): Promise<Fixture> {
  await cleanup(client);

  /**
   * Cria o inquilino, em vez de procurar um.
   *
   * `findFirst` + `return null` degradava para "pulado — banco sem
   * organização/integração", e no CI, que roda `migrate deploy` num banco vazio
   * e nada mais, esse era o **único** caminho: o spec ficava verde sem exercitar
   * uma linha do que promete testar.
   */
  const tenant = await ensureTenant(client, SUFFIX);
  const organization = {
    id: tenant.organizationId,
    ownerId: tenant.accountId,
    baseCurrency: tenant.baseCurrency,
  };
  const integration = { id: tenant.integrationId };

  /**
   * D4 — ações são **opt-in por organização**, e o consentimento é por
   * integração. As duas coisas são controles diferentes (§13.5): o primeiro é
   * o kill switch do tenant, o segundo é o registro de que alguém autorizou a
   * Allva a escrever naquela credencial. Um E2E que pulasse qualquer um dos
   * dois testaria um caminho que produção não tem.
   */
  await client.organization.update({
    where: { id: organization.id },
    data: { actionsEnabled: true },
  });

  await client.integrationWriteConsent.deleteMany({
    where: { integrationId: integration.id },
  });

  await client.integrationWriteConsent.create({
    data: {
      integrationId: integration.id,
      organizationId: organization.id,
      grantedByAccountId: organization.ownerId,
      consentedActionTypes: ['PAUSE_AD'],
    },
  });

  const adAccount = await client.adAccount.create({
    data: {
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: 'META',
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta do E2E',
      integrationId: integration.id,
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  const campaign = await client.campaign.create({
    data: {
      id: `${SUFFIX}-campaign`,
      adAccountId: adAccount.id,
      organizationId: organization.id,
      platform: 'META',
      integrationId: integration.id,
      externalCampaignId: `${SUFFIX}-camp-ext`,
      name: 'Campanha do E2E',
      currency: 'BRL',
    },
  });

  const ad = await client.ad.create({
    data: {
      id: `${SUFFIX}-ad`,
      accountId: organization.ownerId,
      organizationId: organization.id,
      adAccountId: adAccount.id,
      integrationId: integration.id,
      platform: 'META',
      externalAdId: `${SUFFIX}-ad-ext`,
      campaignId: campaign.id,
      lineageId: `${SUFFIX}-ad`,
      name: 'Anúncio que queima',
      observedStatus: 'ACTIVE',
      syncState: 'IN_SYNC',
      dataMaturity: 'MATURE',
      currentAiScore: 31,
      currentScoreConfidence: 0.8,
      currentScoreCoverage: 0.9,
    },
  });

  // A janela PRÉ: gasto real, zero conversão. É contra ela que a medição compara.
  const appliedAt = new Date();
  await client.adMetricSnapshot.createMany({
    data: Array.from({ length: 14 }, (_, index) => {
      const date = new Date(appliedAt);
      date.setUTCDate(date.getUTCDate() - (index + 1));
      date.setUTCHours(0, 0, 0, 0);

      return {
        id: `${SUFFIX}-pre-${index}`,
        adId: ad.id,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        platform: 'META' as const,
        date,
        campaignId: campaign.id,
        spend: 100,
        impressions: 1_000,
        clicks: 10,
        conversions: 0,
        revenue: 0,
        currency: 'BRL',
        baseCurrency: organization.baseCurrency ?? 'BRL',
        spendBase: 100,
        revenueBase: 0,
        fxRate: 1,
        normalizationPending: false,
        accountTimezone: 'America/Sao_Paulo',
      };
    }),
  });

  const wasteItem = await client.wasteItem.create({
    data: {
      adId: ad.id,
      organizationId: organization.id,
      accountId: organization.ownerId,
      findingKind: 'WASTE',
      type: 'ZERO_CONVERSIONS',
      priority: 'CRITICAL',
      windowDays: 14,
      incurredAmount: 1_400,
      incurredAmountBase: 1_400,
      avoidableDailyAmount: 100,
      avoidableDailyBase: 100,
      currency: 'BRL',
      baseCurrency: organization.baseCurrency ?? 'BRL',
      diagnosis: '14 dias de gasto sem nenhuma conversão.',
      evidence: { schemaVersion: 1, observed: { spendBase: 1_400 } },
      evidenceSufficiency: 'SUFFICIENT',
      scopeLevel: 'AD',
      dataMaturity: 'MATURE',
      detectorVersion: 'v2.0.0',
      detectorProfileVersion: 'default-v1',
      fingerprint: `${SUFFIX}-fingerprint`,
    },
  });

  const recommendation = await client.recommendation.create({
    data: {
      adId: ad.id,
      organizationId: organization.id,
      accountId: organization.ownerId,
      kind: 'PAUSE_UNDERPERFORMING_AD',
      title: 'Pausar anúncio sem retorno',
      rationale: '14 dias, R$ 1.400 gastos, zero conversão.',
      impacts: {
        schemaVersion: 1,
        impacts: [
          {
            type: 'SAVINGS',
            estimatedBase: 1_400,
            horizonDays: 14,
            confidence: 0.9,
          },
        ],
      },
      primaryImpactType: 'SPEND_AVOIDED',
      currency: 'BRL',
      baseCurrency: organization.baseCurrency ?? 'BRL',
      priority: 'CRITICAL',
      status: 'NEW',
      engineVersion: 'reco-v2.0.0',
      evidenceAsOf: new Date(),
      wasteItems: { create: [{ wasteItemId: wasteItem.id }] },
      // P3 — o plano nasce com a ação, e é ela que o apply executa (§9.5.4).
      actions: {
        create: [
          {
            adId: ad.id,
            organizationId: organization.id,
            origin: 'RECOMMENDATION',
            type: 'PAUSE_AD',
            level: 'AD',
            parameters: { schemaVersion: 1, adId: ad.id },
            targetEntityType: 'AD',
            targetEntityId: ad.id,
            reversible: true,
          },
        ],
      },
    },
  });

  return {
    organizationId: organization.id,
    accountId: organization.ownerId,
    adId: ad.id,
    recommendationId: recommendation.id,
    wasteItemId: wasteItem.id,
  };
}

async function withFixture(
  assertion: (client: PrismaService, fixture: Fixture) => Promise<void>,
): Promise<void> {
  if (!prisma) {
    console.warn(`[apply-measure-cycle] pulado — sem banco (${skipReason})`);
    return;
  }

  /**
   * Sem ramo de "pulado por falta de dado", e a ausência é a correção.
   *
   * Era ele que deixava o spec verde no CI sem rodar nada: banco migrado e
   * vazio não tinha organização, e o teste saía por aqui. O fixture cria o que
   * precisa, então não há mais como pular em silêncio.
   */
  const fixture = await seed(prisma);

  queue.reset();

  try {
    await assertion(prisma, fixture);
  } finally {
    /**
     * Sem restaurar `actionsEnabled`: a organização é do fixture e some aqui.
     *
     * O restore existia porque o spec ligava a escrita numa organização
     * **emprestada** do banco e não podia devolvê-la ligada. Com inquilino
     * próprio não há o que devolver — e a tentativa quebrava, porque `cleanup`
     * já a tinha apagado.
     */
    await cleanup(prisma);
  }
}

describe('§17.3 — aplicar → resolver → medir, ponta a ponta', () => {
  it('o clique aplica o plano, resolve o achado e grava a régua do outcome', async () => {
    await withFixture(async (client, fixture) => {
      const applyPlan = app!.get(ApplyRecommendationPlanUseCase);

      const applied = await applyPlan.execute({
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        recommendationId: fixture.recommendationId,
        body: { dryRun: false },
        correlationId: 'e2e-correlation',
        ipAddress: null,
        userAgent: null,
      });

      // A recusa vira linha do relatório, não exceção: sem esta asserção, uma
      // guarda barrando faria as de baixo falharem com `undefined`, e o motivo
      // real ficaria escondido.
      expect(applied.data).toMatchObject({ status: 'APPLYING' });

      // ── passo 4: a escrita saiu pelo caminho único, com origem declarada ──
      const execution = await client.actionExecution.findFirst({
        where: { action: { recommendationId: fixture.recommendationId } },
        include: { action: true },
      });

      expect(execution?.status).toBe('SUCCEEDED');
      // P3 — a origem viaja com a ação. Antes de A2-S9 isto era `USER_DIRECT`
      // fixo, e o dataset de acurácia perdia o vínculo que ele mede.
      expect(execution?.action.origin).toBe('RECOMMENDATION');
      expect(execution?.action.recommendationId).toBe(fixture.recommendationId);

      // **Uma ação, não duas.** Aplicar executa a `AdAction` do plano; criar
      // outra faria a trilha de P5 contar o dobro do que alguém pediu.
      const actions = await client.adAction.count({
        where: { recommendationId: fixture.recommendationId },
      });
      expect(actions).toBe(1);

      // ── passo 5: todas SUCCEEDED ⇒ APPLIED ──
      const recommendation = await client.recommendation.findUnique({
        where: { id: fixture.recommendationId },
      });
      expect(recommendation?.status).toBe('APPLIED');
      expect(recommendation?.appliedAt).not.toBeNull();

      // ── passo 6: o outcome nasce na MESMA transação, com o pré capturado ──
      const outcome = await client.recommendationOutcome.findUnique({
        where: { recommendationId: fixture.recommendationId },
      });

      expect(outcome).not.toBeNull();
      expect(outcome?.status).toBe('PENDING_MEASUREMENT');
      expect(outcome?.appliedAt).toEqual(recommendation?.appliedAt);
      // 14 dias × R$ 100. É a régua contra a qual o impacto será medido.
      expect(Number(outcome?.preSpendBase)).toBeCloseTo(1_400, 2);
      expect(outcome?.lineageId).toBe(fixture.adId);

      // ── passo 8: os achados vinculados são resolvidos por AÇÃO ──
      const wasteItem = await client.wasteItem.findUnique({
        where: { id: fixture.wasteItemId },
      });
      expect(wasteItem?.status).toBe('RESOLVED');
      expect(wasteItem?.resolutionKind).toBe('RESOLVED_BY_ACTION');
      expect(wasteItem?.resolvedByActionExecutionId).toBe(execution?.id);

      // ── passo 10: a escada de verificação foi agendada, não executada ──
      expect(queue.countOf('verify-action')).toBe(1);
    });
  });

  /**
   * A2-S9, entrega 1 — e o passo 6 da Definition of Done.
   *
   * A janela pós precisa **fechar**, e a de re-declaração da conta também
   * (§8.9): o outcome recém-criado não é medível hoje. O teste envelhece o
   * `appliedAt` para o passado em vez de esperar 28 dias — é a única parte do
   * ciclo que não dá para exercitar em tempo real, e falsificá-la seria pior
   * que não a testar.
   */
  it('com as duas janelas fechadas, a medição produz veredito e versão', async () => {
    await withFixture(async (client, fixture) => {
      const applyPlan = app!.get(ApplyRecommendationPlanUseCase);
      const measure = app!.get(MeasureOutcomesService);

      await applyPlan.execute({
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        recommendationId: fixture.recommendationId,
        body: { dryRun: false },
        correlationId: 'e2e-correlation',
        ipAddress: null,
        userAgent: null,
      });

      // Envelhece a aplicação: 14 de janela pós + 14 de re-declaração + folga.
      const appliedAt = new Date();
      appliedAt.setUTCDate(appliedAt.getUTCDate() - 40);
      await client.recommendationOutcome.update({
        where: { recommendationId: fixture.recommendationId },
        data: { appliedAt },
      });

      // A janela PÓS: o anúncio pausou, e o gasto foi observado indo a zero.
      // **Observado** é a palavra: linhas com gasto zero, não ausência de linha.
      await client.adMetricSnapshot.createMany({
        data: Array.from({ length: 14 }, (_, index) => {
          const date = new Date(appliedAt);
          date.setUTCDate(date.getUTCDate() + index);
          date.setUTCHours(0, 0, 0, 0);

          return {
            id: `${SUFFIX}-post-${index}`,
            adId: fixture.adId,
            organizationId: fixture.organizationId,
            adAccountId: `${SUFFIX}-account`,
            platform: 'META' as const,
            date,
            campaignId: `${SUFFIX}-campaign`,
            spend: 0,
            impressions: 0,
            clicks: 0,
            conversions: 0,
            revenue: 0,
            currency: 'BRL',
            baseCurrency: 'BRL',
            spendBase: 0,
            revenueBase: 0,
            fxRate: 1,
            normalizationPending: false,
            accountTimezone: 'America/Sao_Paulo',
          };
        }),
      });

      const result = await measure.execute({
        organizationId: fixture.organizationId,
        ctx: testJobContext(),
        now: new Date(),
      });

      expect(result.measured).toBeGreaterThanOrEqual(1);
      // P8: nenhuma aplicada sem outcome. Zero é o único valor aceitável.
      expect(result.unmeasurable).toEqual([]);

      const outcome = await client.recommendationOutcome.findUnique({
        where: { recommendationId: fixture.recommendationId },
      });

      expect(outcome?.status).toBe('MEASURED');
      expect(outcome?.verdict).toBe('IMPROVED');
      // R$ 1.400 que deixaram de sair. `observedDelta`, jamais `causedSavings`.
      expect(Number(outcome?.observedDelta)).toBeCloseTo(1_400, 2);
      expect(outcome?.measurementVersion).toMatch(/^measure-/);
      expect(outcome?.measuredAt).not.toBeNull();
    });
  });

  /**
   * §9.5 passo 4 — dois cliques não disparam dois planos.
   *
   * I2 protege o **alvo**, e um plano com dois alvos passaria por ela. A guarda
   * é a transição condicionada a `NEW`/`ACKNOWLEDGED`, no banco.
   */
  it('o segundo clique é recusado, e não há segunda escrita', async () => {
    await withFixture(async (client, fixture) => {
      const applyPlan = app!.get(ApplyRecommendationPlanUseCase);

      const input = {
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        recommendationId: fixture.recommendationId,
        body: { dryRun: false },
        correlationId: 'e2e-correlation',
        ipAddress: null,
        userAgent: null,
      };

      await applyPlan.execute(input);
      await expect(applyPlan.execute(input)).rejects.toMatchObject({
        code: 'RECOMMENDATION_NOT_APPLICABLE',
      });

      const executions = await client.actionExecution.count({
        where: { action: { recommendationId: fixture.recommendationId } },
      });
      expect(executions).toBe(1);

      const outcomes = await client.recommendationOutcome.count({
        where: { recommendationId: fixture.recommendationId },
      });
      expect(outcomes).toBe(1);
    });
  });
});
