import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { CreativeAnalysisPrismaRepository } from '../../src/modules/creative-lab/infrastructure/database/prisma/creative-analysis-prisma.repository';
import {
  CANDIDATE_POOL_SIZE,
  MIN_CANDIDATE_SCORE,
} from '../../src/modules/creative-lab/domain/creative-candidates';

/**
 * **A leitura de candidatos de substituição** — o custo real da análise.
 *
 * Ela carregava todos os criativos da conta de anúncios, com os anúncios
 * pontuados de cada um, sem paginação e sem filtro de score, para no fim
 * escolher três candidatos. Numa conta grande era a consulta mais pesada da
 * requisição, e roda a cada análise nova.
 *
 * O teste vive aqui porque a correção **é** SQL — agregação, `HAVING` e `LIMIT`.
 * Um dublê provaria que o caso de uso chama o repositório, não que a consulta
 * agrega certo nem que ela para no teto.
 */
const SUFFIX = 'candidates-pool-spec';

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('creative-candidates-pool');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.creative.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adSet.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: as tabelas acima referenciam a organização do inquilino.
  await removeTenant(client, SUFFIX);
}

type Fixture = { organizationId: string; adAccountId: string };

/**
 * Criativos com score decrescente, mais três casos de borda:
 *
 * - um abaixo de {@link MIN_CANDIDATE_SCORE}, que o `HAVING` tem de cortar;
 * - um sem `content_hash`, que não tem como ser comparado;
 * - um sem anúncio pontuado, que não sustenta média nenhuma.
 */
async function seed(
  client: PrismaService,
  creativeCount: number,
): Promise<Fixture | null> {
  await cleanup(client);

  /**
   * Cria o inquilino, em vez de procurar um.
   *
   * `findFirst` + `return null` degradava para `expect('sem fixture')` na
   * máquina de quem tem o banco semeado — e passava. No CI, que roda
   * `migrate deploy` num banco **vazio** e nada mais, não havia organização
   * nenhuma: o teste ficava verde sem exercitar uma linha do que promete testar.
   */
  const tenant = await ensureTenant(client, SUFFIX);
  const organization = { id: tenant.organizationId, ownerId: tenant.accountId };
  const integration = { id: tenant.integrationId };

  const base = {
    organizationId: organization.id,
    integrationId: integration.id,
    platform: 'META' as const,
  };

  const adAccount = await client.adAccount.create({
    data: {
      ...base,
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta dos candidatos',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
    },
  });

  const campaign = await client.campaign.create({
    data: {
      ...base,
      id: `${SUFFIX}-campaign`,
      adAccountId: adAccount.id,
      externalCampaignId: `${SUFFIX}-campaign-ext`,
      name: 'Campanha dos candidatos',
      currency: 'BRL',
    },
  });

  const adSet = await client.adSet.create({
    data: {
      // `ad_sets` não tem `integration_id` — por isso não espalha `base` aqui.
      organizationId: base.organizationId,
      platform: base.platform,
      id: `${SUFFIX}-adset`,
      adAccountId: adAccount.id,
      campaignId: campaign.id,
      externalAdSetId: `${SUFFIX}-adset-ext`,
      name: 'Conjunto dos candidatos',
    },
  });

  for (let index = 0; index < creativeCount; index += 1) {
    const key = String(index).padStart(3, '0');
    const creativeId = `${SUFFIX}-creative-${key}`;

    // Scores de 95 para baixo. Perto do fim eles cruzam o piso de 55.
    const score = 95 - index * 0.5;

    await client.creative.create({
      data: {
        // `creatives` não tem `integration_id`.
        organizationId: base.organizationId,
        platform: base.platform,
        id: creativeId,
        adAccountId: adAccount.id,
        externalCreativeId: `${creativeId}-ext`,
        name: `Criativo ${key}`,
        contentHash: `hash-${key}`,
      },
    });

    await client.ad.create({
      data: {
        ...base,
        id: `${SUFFIX}-ad-${key}`,
        accountId: organization.ownerId,
        adAccountId: adAccount.id,
        campaignId: campaign.id,
        adSetId: adSet.id,
        creativeId,
        externalAdId: `${SUFFIX}-ad-${key}-ext`,
        name: `Anúncio ${key}`,
        lineageId: `${SUFFIX}-ad-${key}`,
        currentAiScore: score,
        scoreAsOf: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
  }

  // Sem hash: não há como medir dissimilaridade contra o criativo cansado.
  await client.creative.create({
    data: {
      // `creatives` não tem `integration_id`.
      organizationId: base.organizationId,
      platform: base.platform,
      id: `${SUFFIX}-creative-nohash`,
      adAccountId: adAccount.id,
      externalCreativeId: `${SUFFIX}-nohash-ext`,
      name: 'Sem hash',
      contentHash: null,
    },
  });
  await client.ad.create({
    data: {
      ...base,
      id: `${SUFFIX}-ad-nohash`,
      accountId: organization.ownerId,
      adAccountId: adAccount.id,
      campaignId: campaign.id,
      adSetId: adSet.id,
      creativeId: `${SUFFIX}-creative-nohash`,
      externalAdId: `${SUFFIX}-ad-nohash-ext`,
      name: 'Anúncio sem hash',
      lineageId: `${SUFFIX}-ad-nohash`,
      currentAiScore: 99,
      scoreAsOf: new Date('2026-09-01T00:00:00.000Z'),
    },
  });

  // Sem anúncio pontuado: média de nada não é zero, é ausência.
  await client.creative.create({
    data: {
      // `creatives` não tem `integration_id`.
      organizationId: base.organizationId,
      platform: base.platform,
      id: `${SUFFIX}-creative-unscored`,
      adAccountId: adAccount.id,
      externalCreativeId: `${SUFFIX}-unscored-ext`,
      name: 'Sem score',
      contentHash: 'hash-unscored',
    },
  });

  return { organizationId: organization.id, adAccountId: adAccount.id };
}

describe('candidatos de substituição — a leitura é limitada', () => {
  it('para no tamanho do pool, mesmo com muito mais criativos na conta', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma, CANDIDATE_POOL_SIZE + 30);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new CreativeAnalysisPrismaRepository(prisma);
    const candidates = await repo.candidatesFor(fixture);

    expect(candidates).toHaveLength(CANDIDATE_POOL_SIZE);
  }, 60_000);

  it('traz os melhores, em ordem de score', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma, 10);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new CreativeAnalysisPrismaRepository(prisma);
    const candidates = await repo.candidatesFor(fixture);

    const scores = candidates.map((candidate) => candidate.averageScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(candidates[0]?.creativeId).toBe(`${SUFFIX}-creative-000`);
  }, 60_000);

  /**
   * O `HAVING` na origem, e não um `filter` depois.
   *
   * Um criativo abaixo do piso nunca seria candidato: trazê-lo para a aplicação
   * para descartá-lo lá é exatamente o trabalho que a consulta existe para não
   * fazer.
   */
  it('não traz criativo abaixo do piso de score', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    // 90 criativos: os scores vão de 95 até 50, cruzando o piso de 55.
    const fixture = await seed(prisma, 90);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new CreativeAnalysisPrismaRepository(prisma);
    const candidates = await repo.candidatesFor(fixture);

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.averageScore).toBeGreaterThanOrEqual(
        MIN_CANDIDATE_SCORE,
      );
    }
  }, 60_000);

  it('descarta criativo sem hash e criativo sem anúncio pontuado', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma, 5);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new CreativeAnalysisPrismaRepository(prisma);
    const ids = (await repo.candidatesFor(fixture)).map((c) => c.creativeId);

    // O sem-hash tem score 99 e seria o primeiro se entrasse.
    expect(ids).not.toContain(`${SUFFIX}-creative-nohash`);
    expect(ids).not.toContain(`${SUFFIX}-creative-unscored`);
  }, 60_000);

  it('agrega média, amostra e conjuntos como a versão em memória agregava', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma, 3);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new CreativeAnalysisPrismaRepository(prisma);
    const [first] = await repo.candidatesFor(fixture);

    expect(first).toMatchObject({
      creativeId: `${SUFFIX}-creative-000`,
      contentHash: 'hash-000',
      averageScore: 95,
      sampleSize: 1,
      ranInAdSetIds: [`${SUFFIX}-adset`],
      lastRanAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  }, 60_000);
});
