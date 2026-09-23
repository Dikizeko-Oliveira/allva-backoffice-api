import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { MemberUsageService } from '../../src/modules/billing/member-usage.service';

/**
 * **O consumo das cotas por membro** — atribuição, não segunda parede.
 *
 * A cota continua sendo da organização: dividi-la por assento bloquearia um
 * usuário enquanto o time tem folga. O que faltava era saber de quem foi, e o
 * dado já estava em `account_id` desde sempre.
 *
 * Vive aqui porque a consulta é SQL cru com `FULL JOIN` entre dois agregados —
 * a parte que erra sozinha é justamente quem usa **uma** feature só.
 */
const SUFFIX = 'member-usage-spec';
const NOW = new Date('2026-09-15T12:00:00.000Z');

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('member-usage');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.copyVariant.deleteMany({
    where: { generation: { adId: { startsWith: SUFFIX } } },
  });
  await client.copyGeneration.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.creativeAnalysis.deleteMany({
    where: { creativeId: { startsWith: SUFFIX } },
  });
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.creative.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  /**
   * Por último, e ele apaga as contas também.
   *
   * Um `account.deleteMany` antes daqui estouraria `organizations_owner_id_fkey`:
   * a conta do inquilino é dona da organização, e a organização só sai dentro de
   * `removeTenant`. A ordem certa é integração → organização → conta, e é ela
   * que o fixture encapsula justamente para não ser reconstruída em cada spec.
   */
  await removeTenant(client, SUFFIX);
}

type Fixture = { organizationId: string; analista: string; redator: string };

/**
 * Dois membros com perfis opostos: um só analisa, o outro só gera copy.
 *
 * É o caso que um `JOIN` interno perderia — e é o mais comum numa equipe real,
 * onde as funções se dividem.
 */
async function seed(client: PrismaService): Promise<Fixture | null> {
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

  const analista = await client.account.create({
    data: {
      id: `${SUFFIX}-analista`,
      name: 'Analista',
      email: `${SUFFIX}-analista@exemplo.com`,
      passwordHash: 'nao-usado-neste-teste',
    },
  });

  const redator = await client.account.create({
    data: {
      id: `${SUFFIX}-redator`,
      name: 'Redator',
      email: `${SUFFIX}-redator@exemplo.com`,
      passwordHash: 'nao-usado-neste-teste',
    },
  });

  const adAccount = await client.adAccount.create({
    data: {
      ...base,
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta',
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
      name: 'Campanha',
      currency: 'BRL',
    },
  });

  const creative = await client.creative.create({
    data: {
      // `creatives` não tem `integration_id`.
      organizationId: base.organizationId,
      platform: base.platform,
      id: `${SUFFIX}-creative`,
      adAccountId: adAccount.id,
      externalCreativeId: `${SUFFIX}-creative-ext`,
      name: 'Criativo',
      contentHash: 'hash',
    },
  });

  const ad = await client.ad.create({
    data: {
      ...base,
      id: `${SUFFIX}-ad`,
      accountId: organization.ownerId,
      adAccountId: adAccount.id,
      campaignId: campaign.id,
      creativeId: creative.id,
      externalAdId: `${SUFFIX}-ad-ext`,
      name: 'Anúncio',
      lineageId: `${SUFFIX}-ad`,
    },
  });

  // Três análises do analista, dentro do mês.
  for (let index = 0; index < 3; index += 1) {
    await client.creativeAnalysis.create({
      data: {
        organizationId: organization.id,
        accountId: analista.id,
        creativeId: creative.id,
        adId: ad.id,
        version: index + 1,
        status: 'COMPLETED',
        trigger: 'MANUAL',
        engineVersion: 'creative-v2.0.0',
        startedAt: new Date('2026-09-10T10:00:00.000Z'),
        completedAt: new Date('2026-09-10T10:00:01.000Z'),
      },
    });
  }

  // Uma análise do analista **fora** do mês: não pode entrar.
  await client.creativeAnalysis.create({
    data: {
      organizationId: organization.id,
      accountId: analista.id,
      creativeId: creative.id,
      adId: ad.id,
      version: 99,
      status: 'COMPLETED',
      trigger: 'MANUAL',
      engineVersion: 'creative-v2.0.0',
      startedAt: new Date('2026-08-10T10:00:00.000Z'),
      completedAt: new Date('2026-08-10T10:00:01.000Z'),
    },
  });

  const generation = {
    organizationId: organization.id,
    adId: ad.id,
    creativeId: creative.id,
    source: 'IMPROVE' as const,
    context: {},
    inputDigest: 'digest',
    engineVersion: 'copy-v1.0.0',
    promptVersion: 'copy-generation-v1',
    retentionUntil: new Date('2026-11-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
  };

  // Duas gerações concluídas do redator, mais uma que caiu por provider fora do
  // ar — esta não foi cobrada de ninguém e não pode ser atribuída.
  await client.copyGeneration.createMany({
    data: [
      { ...generation, accountId: redator.id, status: 'COMPLETED' },
      { ...generation, accountId: redator.id, status: 'COMPLETED' },
      { ...generation, accountId: redator.id, status: 'AI_UNAVAILABLE' },
    ],
  });

  return {
    organizationId: organization.id,
    analista: analista.id,
    redator: redator.id,
  };
}

describe('consumo por membro', () => {
  it('atribui cada cota a quem a consumiu', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const service = new MemberUsageService(prisma);
    const rows = await service.forOrganization(fixture.organizationId, NOW);
    const byId = new Map(rows.map((row) => [row.accountId, row]));

    expect(byId.get(fixture.analista)).toMatchObject({
      name: 'Analista',
      creativeAnalyses: 3,
      copyGenerations: 0,
    });
    expect(byId.get(fixture.redator)).toMatchObject({
      name: 'Redator',
      creativeAnalyses: 0,
      copyGenerations: 2,
    });
  }, 60_000);

  /**
   * O caso que um `JOIN` interno perderia — e é o mais comum numa equipe real,
   * onde as funções se dividem. Os dois membros aqui usam uma feature cada.
   */
  it('inclui quem usou só uma das duas features', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const service = new MemberUsageService(prisma);
    const ids = (await service.forOrganization(fixture.organizationId, NOW))
      .map((row) => row.accountId)
      .filter((id) => id.startsWith(SUFFIX));

    expect(ids).toContain(fixture.analista);
    expect(ids).toContain(fixture.redator);
  }, 60_000);

  it('não atribui geração que caiu por provider fora do ar', async () => {
    // Ela devolveu a reserva e não foi cobrada. Atribuí-la acusaria um membro
    // por uma falha nossa.
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const service = new MemberUsageService(prisma);
    const rows = await service.forOrganization(fixture.organizationId, NOW);

    expect(
      rows.find((row) => row.accountId === fixture.redator)?.copyGenerations,
    ).toBe(2);
  }, 60_000);

  it('conta só o mês corrente', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const service = new MemberUsageService(prisma);
    const rows = await service.forOrganization(fixture.organizationId, NOW);

    // A quarta análise do analista é de agosto e fica de fora.
    expect(
      rows.find((row) => row.accountId === fixture.analista)?.creativeAnalyses,
    ).toBe(3);
  }, 60_000);

  it('ordena por quem mais consumiu', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const service = new MemberUsageService(prisma);
    const rows = (
      await service.forOrganization(fixture.organizationId, NOW)
    ).filter((row) => row.accountId.startsWith(SUFFIX));

    // O administrador abre esta tela para achar o outlier: ele vem primeiro.
    expect(rows[0]?.accountId).toBe(fixture.analista);
  }, 60_000);
});
