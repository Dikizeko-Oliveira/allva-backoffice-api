import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { RecommendationsPrismaRepository } from '../../src/modules/recommendations/infrastructure/database/prisma/recommendations-prisma.repository';
import type { RecommendationPlan } from '../../src/modules/recommendations/domain/recommendation-plan';

/**
 * **`recommendations_active_unique` sob geração concorrente** — gate de A2-S6.
 *
 * O índice é parcial: `(ad_id, kind)` único **enquanto** o status é `NEW`,
 * `ACKNOWLEDGED` ou `APPLYING`. Sob duas gerações simultâneas — cron e gatilho
 * por evento na mesma janela — a alternativa a ele seria duas recomendações
 * idênticas na tela, cada uma com metade dos vínculos N:N e cada uma criando as
 * próprias `AdAction`.
 *
 * O teste roda as duas persistências **em paralelo de verdade**, contra o
 * Postgres: um dublê provaria que o `try/catch` compila, não que o banco recusa.
 * E verifica o que mais importa — que a recusa seja **limpa**: nenhuma ação
 * órfã, nenhum vínculo pendurado. A transação de §9.4 passo 5 existe para isso.
 */
const SUFFIX = 'reco-unique-spec';

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected(
    'recommendations-active-unique',
  );

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.adAction.deleteMany({ where: { adId: { startsWith: SUFFIX } } });
  await client.recommendation.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: as tabelas acima referenciam a organização do inquilino.
  await removeTenant(client, SUFFIX);
}

type Fixture = { organizationId: string; accountId: string; adId: string };

async function seed(client: PrismaService): Promise<Fixture | null> {
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
  const organization = { id: tenant.organizationId, ownerId: tenant.accountId };
  const integration = { id: tenant.integrationId };

  const adAccount = await client.adAccount.create({
    data: {
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: 'META',
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta do gate de unicidade',
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
      integrationId: integration.id,
      platform: 'META',
      externalCampaignId: `${SUFFIX}-campaign-ext`,
      name: 'Campanha do gate',
      currency: 'BRL',
    },
  });

  const adId = `${SUFFIX}-ad`;

  await client.ad.create({
    data: {
      id: adId,
      accountId: organization.ownerId,
      organizationId: organization.id,
      adAccountId: adAccount.id,
      integrationId: integration.id,
      platform: 'META',
      externalAdId: `${SUFFIX}-ad-ext`,
      campaignId: campaign.id,
      name: 'Anúncio do gate de unicidade',
      lineageId: adId,
    },
  });

  return {
    organizationId: organization.id,
    accountId: organization.ownerId,
    adId,
  };
}

async function withDatabase(
  assertion: (client: PrismaService, fixture: Fixture) => Promise<void>,
): Promise<void> {
  if (!prisma) {
    console.warn(`[reco-unique] pulado — sem banco alcançável (${reason})`);
    return;
  }

  const fixture = await seed(prisma);

  // Banco alcançável mas **sem seed**: pular com o motivo, pela mesma razão de
  // pular sem banco. Um teste que falha por ausência de dado de fixture ensina
  // o time a ignorar vermelho — e `pnpm seed:ads-v2` é o que o torna verde.
  if (!fixture) {
    console.warn(
      `[%s] pulado — banco sem organização/integração. Rode: pnpm seed:ads-v2`,
      'reco-unique',
    );
    return;
  }

  try {
    await assertion(prisma, fixture);
  } finally {
    await cleanup(prisma);
  }
}

function planFor(adId: string): RecommendationPlan {
  return {
    adId,
    kind: 'PAUSE_UNDERPERFORMING_AD',
    advisory: false,
    priority: 'CRITICAL',
    title: 'Pausar anúncio sem retorno',
    rationale: 'fixture',
    guidance: null,
    outOfScopeReason: null,
    blockedReason: null,
    wasteItemIds: [],
    impacts: [
      {
        type: 'SAVINGS',
        estimatedBase: 1_400,
        horizonDays: 14,
        confidence: 0.8,
      },
    ],
    primaryImpactType: 'SPEND_AVOIDED',
    actions: [
      {
        type: 'PAUSE_AD',
        level: 'AD',
        targetEntityType: 'AD',
        targetEntityId: adId,
        parameters: { adId },
        scopeWarning: null,
        reversible: true,
        requiresRecreate: false,
      },
    ],
    evidence: { avoidableDailyBase: 100 },
    evidenceAsOf: new Date(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  };
}

describe('recommendations_active_unique sob geração concorrente', () => {
  jest.setTimeout(30_000);

  it('duas gerações simultâneas do mesmo (ad, kind) ⇒ uma só sobrevive', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new RecommendationsPrismaRepository(client);

      const persist = () =>
        repository.persistPlan({
          plan: planFor(fixture.adId),
          organizationId: fixture.organizationId,
          accountId: fixture.accountId,
          currency: 'BRL',
          baseCurrency: 'BRL',
          engineVersion: 'reco-v2.0.0',
          deferral: null,
        });

      const [first, second] = await Promise.all([persist(), persist()]);

      const persisted = [first, second].filter((item) => item !== null);
      expect(persisted).toHaveLength(1);

      const rows = await client.recommendation.count({
        where: { adId: fixture.adId, status: 'NEW' },
      });
      expect(rows).toBe(1);
    });
  });

  it('a recusa é limpa — nenhuma AdAction órfã fica para trás', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new RecommendationsPrismaRepository(client);

      const persist = () =>
        repository.persistPlan({
          plan: planFor(fixture.adId),
          organizationId: fixture.organizationId,
          accountId: fixture.accountId,
          currency: 'BRL',
          baseCurrency: 'BRL',
          engineVersion: 'reco-v2.0.0',
          deferral: null,
        });

      await Promise.all([persist(), persist(), persist()]);

      // Uma recomendação, uma ação. Sem a transação de §9.4 passo 5, a perdedora
      // deixaria a `AdAction` gravada apontando para uma recomendação que a
      // constraint recusou — e P3 quebraria pelo lado do dado, não do código.
      const [recommendations, actions] = await Promise.all([
        client.recommendation.count({ where: { adId: fixture.adId } }),
        client.adAction.count({ where: { adId: fixture.adId } }),
      ]);

      expect(recommendations).toBe(1);
      expect(actions).toBe(1);
    });
  });

  it('toda AdAction persistida tem origin e recommendationId (P3)', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new RecommendationsPrismaRepository(client);

      await repository.persistPlan({
        plan: planFor(fixture.adId),
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        currency: 'BRL',
        baseCurrency: 'BRL',
        engineVersion: 'reco-v2.0.0',
        deferral: null,
      });

      const action = await client.adAction.findFirstOrThrow({
        where: { adId: fixture.adId },
      });

      expect(action.origin).toBe('RECOMMENDATION');
      expect(action.recommendationId).not.toBeNull();
      // O alvo é o que sustenta a I2 generalizada: a exclusão é por entidade,
      // não por anúncio.
      expect(action.targetEntityType).toBe('AD');
      expect(action.targetEntityId).toBe(fixture.adId);
      // Parâmetros versionados (G15): uma ação gravada hoje continua legível
      // quando `REPLACE_COPY` ganhar campos em A2-S7.
      expect(action.parameters).toMatchObject({ schemaVersion: 1 });
    });
  });

  it('resolvida deixa de ocupar o slot — o índice é PARCIAL', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new RecommendationsPrismaRepository(client);

      const first = await repository.persistPlan({
        plan: planFor(fixture.adId),
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        currency: 'BRL',
        baseCurrency: 'BRL',
        engineVersion: 'reco-v2.0.0',
        deferral: null,
      });

      expect(first).not.toBeNull();

      await client.recommendation.update({
        where: { id: first!.id },
        data: { status: 'DISMISSED' },
      });

      // O problema pode voltar, e a recomendação tem de poder voltar com ele.
      // Um índice total travaria o `(ad, kind)` para sempre depois da primeira.
      const second = await repository.persistPlan({
        plan: planFor(fixture.adId),
        organizationId: fixture.organizationId,
        accountId: fixture.accountId,
        currency: 'BRL',
        baseCurrency: 'BRL',
        engineVersion: 'reco-v2.0.0',
        deferral: null,
      });

      expect(second).not.toBeNull();
    });
  });
});
