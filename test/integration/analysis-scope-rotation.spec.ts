import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { AnalysisScopePrismaRepository } from '../../src/modules/analysis-scope/infrastructure/database/prisma/analysis-scope-prisma.repository';

/**
 * **O rodízio da varredura** — todo anúncio passa, não só os mesmos N.
 *
 * A régua escolhia os N que mais gastaram, toda noite. Como o ranking de gasto é
 * estável, os mesmos anúncios eram olhados para sempre: um cliente com 5.000
 * anúncios no plano de 300 tinha 4.700 que a Allva nunca analisou — e o anúncio
 * da cauda que começa a desperdiçar só entra em cena quando sobe no ranking, o
 * que ele só faz **gastando mais**.
 *
 * O teste vive aqui porque a correção **é** SQL: janela de ranqueamento,
 * histerese no corte e filtro de entrega. Um dublê provaria que o serviço chama
 * o repositório, não que a seleção faz o que promete.
 */
const SUFFIX = 'scope-rotation-spec';
const WINDOW_SINCE = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_UNTIL = new Date('2026-09-08T00:00:00.000Z');

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('analysis-scope-rotation');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.adMetricSnapshot.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: as tabelas acima referenciam a organização do inquilino.
  await removeTenant(client, SUFFIX);
}

type Fixture = { organizationId: string; adIds: string[] };

/**
 * Dez anúncios com gasto decrescente — `ad-00` gasta mais, `ad-09` menos.
 *
 * Os dois últimos entram **sem entrega**: zero gasto e zero impressão na janela.
 * São a cauda morta que toda conta real tem, e a razão do filtro do rodízio.
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

  const adAccount = await client.adAccount.create({
    data: {
      id: `${SUFFIX}-account`,
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: 'META',
      externalAccountId: `${SUFFIX}-ext`,
      name: 'Conta do rodízio',
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
      name: 'Campanha do rodízio',
      currency: 'BRL',
    },
  });

  const adIds: string[] = [];

  for (let index = 0; index < TOTAL_ADS; index += 1) {
    const adId = `${SUFFIX}-ad-${String(index).padStart(2, '0')}`;
    adIds.push(adId);

    await client.ad.create({
      data: {
        id: adId,
        accountId: organization.ownerId,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        integrationId: integration.id,
        platform: 'META',
        externalAdId: `${adId}-ext`,
        campaignId: campaign.id,
        name: `Anúncio ${index}`,
        lineageId: adId,
      },
    });

    // Os dois últimos são a cauda morta: sem gasto e sem impressão.
    const dead = index >= VIVOS;

    await client.adMetricSnapshot.create({
      data: {
        adId,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        campaignId: campaign.id,
        platform: 'META',
        date: new Date('2026-09-03T00:00:00.000Z'),
        currency: 'BRL',
        baseCurrency: 'BRL',
        accountTimezone: 'America/Sao_Paulo',
        spend: dead ? 0 : 10_000 - index * 100,
        spendBase: dead ? 0 : 10_000 - index * 100,
        impressions: dead ? 0 : 10_000,
      },
    });
  }

  return { organizationId: organization.id, adIds };
}

/**
 * **O teto tem de ficar acima de `MIN_LIMIT_FOR_ROTATION`.**
 *
 * A primeira versão usava 5, e `splitScope` não divide abaixo de 20 — devolve o
 * teto inteiro como núcleo e rodízio zero. O teste afirmava que a vaga andava
 * quando não havia vaga nenhuma, e passava por não estar rodando: sem
 * organização no banco do CI, o fixture degradava e as asserções nunca eram
 * alcançadas.
 *
 * Com 20: núcleo 16, rodízio 4.
 */
const LIMIT = 20;

/** 24 com entrega + 2 mortos — a cauda viva tem de sobrar sobre o núcleo. */
const TOTAL_ADS = 26;
const VIVOS = 24;

function markEligible(
  repo: AnalysisScopePrismaRepository,
  fixture: Fixture,
  now: Date,
) {
  return repo.markEligible({
    organizationId: fixture.organizationId,
    limit: LIMIT,
    since: WINDOW_SINCE,
    until: WINDOW_UNTIL,
    now,
  });
}

async function eligibleIds(
  client: PrismaService,
  organizationId: string,
): Promise<string[]> {
  const rows = await client.ad.findMany({
    where: {
      organizationId,
      id: { startsWith: SUFFIX },
      analysisEligibleAt: { not: null },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  return rows.map((row) => row.id);
}

describe('escopo da varredura — núcleo e rodízio', () => {
  it('respeita o teto do plano: nunca mais que N por noite', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new AnalysisScopePrismaRepository(prisma);
    const outcome = await markEligible(repo, fixture, new Date());

    // A correção não compra cobertura com cota: continuam sendo 20 por noite.
    expect(outcome.eligible).toBe(LIMIT);
  }, 30_000);

  it('o núcleo são os que mais gastam, e o rodízio pega a cauda viva', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new AnalysisScopePrismaRepository(prisma);
    await markEligible(repo, fixture, new Date());

    const selected = await eligibleIds(prisma, fixture.organizationId);

    // Núcleo: os 16 maiores gastos. Rodízio: 4 vagas, e como ninguém foi
    // analisado ainda, o desempate por gasto entrega `ad-16` a `ad-19`.
    expect(selected).toEqual(
      Array.from(
        { length: LIMIT },
        (_, i) => `${SUFFIX}-ad-${String(i).padStart(2, '0')}`,
      ),
    );
  }, 30_000);

  /**
   * **O defeito original, em uma asserção.**
   *
   * Antes, a segunda noite devolvia exatamente o mesmo conjunto da primeira, e a
   * terceira também, para sempre. Agora a vaga de rodízio anda.
   */
  it('a vaga de rodízio anda de uma noite para a outra', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new AnalysisScopePrismaRepository(prisma);

    await markEligible(repo, fixture, new Date('2026-09-08T05:00:00.000Z'));
    const primeira = await eligibleIds(prisma, fixture.organizationId);

    await markEligible(repo, fixture, new Date('2026-09-09T05:00:00.000Z'));
    const segunda = await eligibleIds(prisma, fixture.organizationId);

    expect(primeira).not.toEqual(segunda);

    // O núcleo não se mexe — é o que mantém o achado sendo reconfirmado.
    const nucleo = Array.from(
      { length: 16 },
      (_, i) => `${SUFFIX}-ad-${String(i).padStart(2, '0')}`,
    );
    expect(primeira).toEqual(expect.arrayContaining(nucleo));
    expect(segunda).toEqual(expect.arrayContaining(nucleo));

    // E as vagas que giraram são as do rodízio: `ad-16` deu lugar a `ad-20`.
    expect(primeira).toContain(`${SUFFIX}-ad-16`);
    expect(segunda).toContain(`${SUFFIX}-ad-20`);
    expect(segunda).not.toContain(`${SUFFIX}-ad-16`);
  }, 30_000);

  /**
   * **O filtro que torna o ciclo viável.**
   *
   * Sem ele o rodízio gasta vagas em anúncio pausado, sem impressão e sem
   * gasto — e a cauda de uma conta real é majoritariamente isso. Um anúncio que
   * não entrega não pode estar desperdiçando: a vaga dele atrasa o anúncio vivo
   * da fila.
   */
  it('a cauda morta nunca ocupa vaga de rodízio', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new AnalysisScopePrismaRepository(prisma);
    const visto = new Set<string>();

    // Oito noites: mais que suficiente para a cauda viva (ad-16 a ad-23) girar
    // duas vezes com 4 vagas por noite. Se os mortos pudessem entrar, entrariam.
    for (let night = 0; night < 8; night += 1) {
      await markEligible(
        repo,
        fixture,
        new Date(Date.UTC(2026, 8, 8 + night, 5)),
      );

      for (const id of await eligibleIds(prisma, fixture.organizationId)) {
        visto.add(id);
      }
    }

    expect(visto.has(`${SUFFIX}-ad-24`)).toBe(false);
    expect(visto.has(`${SUFFIX}-ad-25`)).toBe(false);

    // E todo anúncio **vivo** passou pela varredura dentro do ciclo.
    for (let index = 0; index < VIVOS; index += 1) {
      const id = `${SUFFIX}-ad-${String(index).padStart(2, '0')}`;
      expect(visto.has(id)).toBe(true);
    }
  }, 60_000);

  it('carimba a memória do rodízio, e não a apaga em quem saiu', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    if (!fixture) return expect('sem fixture').toBeTruthy();

    const repo = new AnalysisScopePrismaRepository(prisma);
    await markEligible(repo, fixture, new Date('2026-09-08T05:00:00.000Z'));
    await markEligible(repo, fixture, new Date('2026-09-09T05:00:00.000Z'));

    // `ad-16` é a primeira vaga de rodízio: entra na noite 1 e sai na noite 2.
    // Um do núcleo (0 a 15) não serviria — ele nunca sai.
    const rotacionado = await prisma.ad.findUnique({
      where: { id: `${SUFFIX}-ad-16` },
      select: { analysisEligibleAt: true, analysisLastScopedAt: true },
    });

    // Saiu do escopo desta noite…
    expect(rotacionado?.analysisEligibleAt).toBeNull();
    // …mas a memória de quando entrou sobrevive, senão o rodízio perde a ordem.
    expect(rotacionado?.analysisLastScopedAt).toEqual(
      new Date('2026-09-08T05:00:00.000Z'),
    );
  }, 30_000);
});
