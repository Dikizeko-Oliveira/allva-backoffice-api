import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { WasteReadPrismaRepository } from '../../src/modules/waste/infrastructure/database/prisma/waste-read-prisma.repository';
import { WasteItemsPrismaRepository } from '../../src/modules/waste/infrastructure/database/prisma/waste-items-prisma.repository';

/**
 * **G14 — o gate mais importante de A2-S5**, contra o Postgres.
 *
 * > *"Rollup não multiplica: ad com 3 achados abertos entra 1×."*
 *
 * A dupla contagem que motivou a v2.0 inteira era no eixo do **nível**. §10.8
 * mostrou que ela reaparece no eixo do **achado**: somar `ads.open_waste_amount_base`
 * — uma coluna do lado 1 — através de um join 1:N com `open_waste` multiplica o
 * valor pela cardinalidade do lado N. A subconsulta pré-agregada por anúncio é a
 * correção, e ela **só existe de verdade contra um banco**: um dublê de
 * repositório provaria que o TypeScript compila, não que o SQL não multiplica.
 *
 * O teste monta a query errada ao lado da certa e mostra as duas respostas. É a
 * única forma de a asserção significar alguma coisa — sem o contraste, "1400"
 * é um número sem oposição.
 *
 * **Pula quando não há banco alcançável**, como os demais testes de integração:
 * um gate que falha por ausência de infraestrutura ensina o time a ignorar
 * vermelho. Com `docker compose up -d`, ele verifica.
 */
const SUFFIX = 'waste-rollup-spec';

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('waste-rollup');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.wasteItem.deleteMany({
    where: { adId: { startsWith: SUFFIX } },
  });
  await client.ad.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adSet.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: as tabelas acima referenciam a organização do inquilino.
  await removeTenant(client, SUFFIX);
}

async function withDatabase(
  assertion: (client: PrismaService, fixture: Fixture) => Promise<void>,
): Promise<void> {
  if (!prisma) {
    console.warn(`[waste-rollup] pulado — sem banco alcançável (${reason})`);
    return;
  }

  const fixture = await seed(prisma);

  // Banco alcançável mas **sem seed**: pular com o motivo, pela mesma razão de
  // pular sem banco. Um teste que falha por ausência de dado de fixture ensina
  // o time a ignorar vermelho — e `pnpm seed:ads-v2` é o que o torna verde.
  if (!fixture) {
    console.warn(
      `[%s] pulado — banco sem organização/integração. Rode: pnpm seed:ads-v2`,
      'waste-rollup',
    );
    return;
  }

  try {
    await assertion(prisma, fixture);
  } finally {
    await cleanup(prisma);
  }
}

type Fixture = {
  organizationId: string;
  accountId: string;
  campaignId: string;
  adId: string;
};

/**
 * Um anúncio com **três** achados abertos e `open_waste_amount_base = 1400`.
 *
 * Os três achados carregam valores diferentes de propósito: se a query somasse
 * `waste_items` em vez da coluna do anúncio, o total também sairia errado — e
 * por outro caminho. O único total correto é 1400, o `max` de §10.6.
 */
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
      name: 'Conta do gate G14',
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
      name: 'Campanha do gate G14',
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
      name: 'Anúncio com três achados',
      lineageId: adId,
      // O `max` de §10.6, já calculado pelo worker: é esta coluna — e somente
      // ela — que o rollup soma.
      openWasteCount: 3,
      openWasteAmount: 1_400,
      openWasteAmountBase: 1_400,
      openWasteCurrency: 'BRL',
      avoidableDailyAmountBase: 100,
      wasteAsOf: new Date(),
    },
  });

  const common = {
    adId,
    organizationId: organization.id,
    accountId: organization.ownerId,
    windowDays: 14,
    currency: 'BRL',
    baseCurrency: 'BRL',
    evidence: {},
    evidenceSufficiency: 'SUFFICIENT',
    scopeLevel: 'AD',
    dataMaturity: 'MATURE',
    detectorVersion: 'v2.0.0',
    detectorProfileVersion: 'waste-thresholds-v1',
    diagnosis: 'fixture',
  };

  await client.wasteItem.createMany({
    data: [
      {
        ...common,
        type: 'ZERO_CONVERSIONS',
        priority: 'CRITICAL',
        incurredAmount: 1_400,
        incurredAmountBase: 1_400,
        avoidableDailyAmount: 100,
        avoidableDailyBase: 100,
        fingerprint: `${SUFFIX}-1`,
      },
      {
        ...common,
        type: 'LOW_CTR',
        priority: 'HIGH',
        incurredAmount: 400,
        incurredAmountBase: 400,
        avoidableDailyAmount: 30,
        avoidableDailyBase: 30,
        fingerprint: `${SUFFIX}-2`,
      },
      {
        ...common,
        type: 'CREATIVE_FATIGUE',
        priority: 'LOW',
        incurredAmount: 250,
        incurredAmountBase: 250,
        avoidableDailyAmount: 20,
        avoidableDailyBase: 20,
        fingerprint: `${SUFFIX}-3`,
      },
      // Uma oportunidade no mesmo anúncio: a view tem de mantê-la fora, e é a
      // view que garante isso — não a disciplina de quem escreve a consulta.
      {
        ...common,
        findingKind: 'OPPORTUNITY',
        type: 'BUDGET_STARVATION',
        priority: 'MEDIUM',
        incurredAmount: 0,
        incurredAmountBase: 0,
        avoidableDailyAmount: 900,
        avoidableDailyBase: 900,
        fingerprint: `${SUFFIX}-4`,
      },
    ],
  });

  return {
    organizationId: organization.id,
    accountId: organization.ownerId,
    campaignId: campaign.id,
    adId,
  };
}

describe('G14 — o rollup não multiplica (§10.8, achado B1)', () => {
  jest.setTimeout(30_000);

  it('um ad com 3 achados abertos contribui UMA vez', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteReadPrismaRepository(client);

      const result = await repository.rollup({
        organizationId: fixture.organizationId,
        groupBy: 'campaign',
        windowDays: 14,
        limit: 10,
      });

      const row = result.rows.find(
        (item) => item.groupId === fixture.campaignId,
      );

      expect(row).toBeDefined();
      expect(row?.affectedAds).toBe(1);
      // 1400, não 4200. A subconsulta é o que faz a diferença.
      expect(row?.openWasteBase).toBe(1_400);
      expect(row?.avoidableDailyBase).toBe(100);
      // Dois dos três achados são HIGH/CRITICAL — contagem sobre o lado N, que
      // é somável por construção.
      expect(row?.criticalItems).toBe(2);
    });
  });

  it('a query SEM a subconsulta multiplica — o contraste é a prova', async () => {
    await withDatabase(async (client, fixture) => {
      // A query de §10.8 como estava escrita na primeira redação: `JOIN` direto
      // e `SUM` da coluna do lado 1. É o achado B1, reproduzido.
      const [wrong] = await client.$queryRawUnsafe<
        Array<{ open_waste_base: string }>
      >(
        `SELECT COALESCE(SUM(a."open_waste_amount_base"), 0) AS open_waste_base
           FROM "ads" a
           JOIN "open_waste" w ON w."ad_id" = a."id"
          WHERE a."organization_id" = $1
            AND a."archived_at" IS NULL`,
        fixture.organizationId,
      );

      // Três achados abertos ⇒ o mesmo 1400 somado três vezes.
      expect(Number(wrong.open_waste_base)).toBe(4_200);
    });
  });

  it('a oportunidade do mesmo anúncio fica fora — garantia da view', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteReadPrismaRepository(client);

      const summary = await repository.summary({
        organizationId: fixture.organizationId,
        windowDays: 14,
      });

      // O `BUDGET_STARVATION` tem 900/dia. Se ele entrasse, o evitável seria
      // 1000 — e o produto reportaria como desperdício um anúncio saudável.
      expect(summary.avoidableDaily?.valueBase).toBe(100);
      expect(summary.affectedAds).toBe(1);
      expect(summary.openCount).toBe(3);
    });
  });

  it('a reconciliação enxerga a divergência que ela existe para corrigir (C3)', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteReadPrismaRepository(client);

      // Nenhum drift no estado semeado: a coluna casa com o `max` da agregação.
      expect(
        await repository.findDenormalizationDrift({
          adAccountId: `${SUFFIX}-account`,
        }),
      ).toEqual([]);

      // Agora a coluna mente — exatamente o que o job diário procura.
      await client.ad.update({
        where: { id: fixture.adId },
        data: { openWasteAmountBase: 99 },
      });

      const drifts = await repository.findDenormalizationDrift({
        adAccountId: `${SUFFIX}-account`,
      });

      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toMatchObject({
        adId: fixture.adId,
        stored: { openWasteAmountBase: 99 },
        actual: { openWasteAmountBase: 1_400, openWasteCount: 3 },
      });
    });
  });
});

/**
 * `POST /ads/{id}/resolve` (§10.9) recalcula a denormalização **na hora**.
 *
 * O `UPDATE ... LEFT JOIN` que faz isso só existe de verdade contra um banco: o
 * caso que ele precisa cobrir — anúncio que ficou **sem nenhum** achado aberto —
 * é justamente o que um `JOIN` interno silenciosamente não atualiza, deixando a
 * coluna com o número da última detecção.
 */
describe('recomputeDenormalization aplica o max de §10.6 (§10.9)', () => {
  jest.setTimeout(30_000);

  it('resolver PARTE dos achados deixa o max dos que sobraram', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteItemsPrismaRepository(client);

      // Fecha o de 1.400. Sobram o de 400 e o de 250 — o novo `max` é 400.
      await client.wasteItem.updateMany({
        where: { fingerprint: `${SUFFIX}-1` },
        // Os dois `CHECK` de coerência (D10/A7) exigem o trio junto: `status`,
        // `resolved_at` e `resolution_kind`. Fechar sem o motivo é a linha que o
        // banco recusa — e recusou este fixture na primeira escrita.
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionKind: 'RESOLVED_EXTERNALLY',
        },
      });

      await repository.recomputeDenormalization([fixture.adId], new Date());

      const ad = await client.ad.findUniqueOrThrow({
        where: { id: fixture.adId },
        select: {
          openWasteCount: true,
          openWasteAmountBase: true,
          avoidableDailyAmountBase: true,
          openWasteCurrency: true,
        },
      });

      expect(ad.openWasteCount).toBe(2);
      // 400, não 650: entre tipos é o **máximo**, nunca a soma (§10.6).
      expect(Number(ad.openWasteAmountBase)).toBe(400);
      expect(Number(ad.avoidableDailyAmountBase)).toBe(30);
      expect(ad.openWasteCurrency).toBe('BRL');
    });
  });

  it('resolver TODOS zera as colunas — o caso do LEFT JOIN', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteItemsPrismaRepository(client);

      await client.wasteItem.updateMany({
        where: { adId: fixture.adId, findingKind: 'WASTE' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionKind: 'RESOLVED_EXTERNALLY',
        },
      });

      await repository.recomputeDenormalization([fixture.adId], new Date());

      const ad = await client.ad.findUniqueOrThrow({
        where: { id: fixture.adId },
        select: {
          openWasteCount: true,
          openWasteAmountBase: true,
          avoidableDailyAmountBase: true,
          openWasteCurrency: true,
        },
      });

      // Sem `LEFT JOIN` o anúncio não apareceria na subconsulta e manteria
      // 1.400 — dinheiro queimando na tela de um anúncio já limpo.
      expect(ad.openWasteCount).toBe(0);
      expect(Number(ad.openWasteAmountBase)).toBe(0);
      expect(Number(ad.avoidableDailyAmountBase)).toBe(0);
      expect(ad.openWasteCurrency).toBeNull();
    });
  });

  it('a oportunidade aberta não sustenta as colunas de desperdício', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteItemsPrismaRepository(client);

      await client.wasteItem.updateMany({
        where: { adId: fixture.adId, findingKind: 'WASTE' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionKind: 'RESOLVED_EXTERNALLY',
        },
      });

      await repository.recomputeDenormalization([fixture.adId], new Date());

      // O `BUDGET_STARVATION` continua **aberto** e tem 900/dia. Se a view não
      // o excluísse, o anúncio limpo apareceria com 900 de evitável.
      const ad = await client.ad.findUniqueOrThrow({
        where: { id: fixture.adId },
        select: { avoidableDailyAmountBase: true, openWasteCount: true },
      });

      expect(Number(ad.avoidableDailyAmountBase)).toBe(0);
      expect(ad.openWasteCount).toBe(0);
    });
  });

  it('resolveForAd fecha só os tipos pedidos', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteItemsPrismaRepository(client);

      const resolved = await repository.resolveForAd({
        adId: fixture.adId,
        organizationId: fixture.organizationId,
        types: ['CREATIVE_FATIGUE'],
        kind: 'RESOLVED_EXTERNALLY',
        reason: 'troquei o criativo',
        resolvedByAccountId: fixture.accountId,
        now: new Date(),
      });

      expect(resolved).toEqual([
        expect.objectContaining({ type: 'CREATIVE_FATIGUE' }),
      ]);

      const stillOpen = await client.wasteItem.count({
        where: { adId: fixture.adId, resolvedAt: null },
      });

      // Dois achados de desperdício mais a oportunidade continuam abertos.
      expect(stillOpen).toBe(3);
    });
  });

  it('o motivo entra na evidência de CADA item, sem apagar os limiares', async () => {
    await withDatabase(async (client, fixture) => {
      const repository = new WasteItemsPrismaRepository(client);

      await client.wasteItem.updateMany({
        where: { adId: fixture.adId },
        data: { evidence: { thresholds: { minSpendBase: 50 } } },
      });

      await repository.resolveForAd({
        adId: fixture.adId,
        organizationId: fixture.organizationId,
        kind: 'DISMISSED',
        reason: 'campanha institucional, sem meta de conversão',
        resolvedByAccountId: fixture.accountId,
        now: new Date(),
      });

      const items = await client.wasteItem.findMany({
        where: { adId: fixture.adId },
        select: { evidence: true, resolutionKind: true, status: true },
      });

      for (const item of items) {
        const evidence = item.evidence as Record<string, unknown>;
        // P7: o motivo da resolução entra **ao lado** dos limiares que
        // dispararam o achado. Um `updateMany` só sobrescreveria as três
        // evidências com o mesmo objeto e apagaria a explicação de cada uma.
        expect(evidence.thresholds).toEqual({ minSpendBase: 50 });
        expect(evidence.manualResolution).toMatchObject({
          kind: 'DISMISSED',
          reason: 'campanha institucional, sem meta de conversão',
        });
        expect(item.status).toBe('RESOLVED');
      }
    });
  });
});
