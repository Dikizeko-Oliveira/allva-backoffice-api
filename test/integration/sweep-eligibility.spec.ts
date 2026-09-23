import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { AdAccountsSyncPrismaRepository } from '../../src/modules/sync/infrastructure/database/prisma/ad-accounts-sync-prisma.repository';
import { AdScoringTargetsPrismaRepository } from '../../src/modules/ad-scoring/infrastructure/database/prisma/ad-scoring-targets-prisma.repository';
import { WasteTargetsPrismaRepository } from '../../src/modules/waste/infrastructure/database/prisma/waste-targets-prisma.repository';
import { RecommendationTargetsPrismaRepository } from '../../src/modules/recommendations/infrastructure/database/prisma/recommendation-targets-prisma.repository';
import { AnalysisScopePrismaRepository } from '../../src/modules/analysis-scope/infrastructure/database/prisma/analysis-scope-prisma.repository';
import { OrganizationSweepPrismaRepository } from '../../src/modules/subscriptions/access/infrastructure/database/prisma/organization-sweep-prisma.repository';

/**
 * **Quem os jobs varrem** — as consultas, e não um dublê delas.
 *
 * A decisão de acesso da organização é testada em unidade; o que só o banco
 * prova é a outra metade: que cada repositório de alvo deixa de fora a conta
 * com token vencido, a desvinculada, a congelada e a de organização excluída —
 * inclusive nas consultas cruas da régua, onde o filtro é SQL escrito à mão e o
 * status da integração é um enum do Postgres.
 */
const SUFFIX = 'sweep-eligibility-spec';
const DIA = 24 * 60 * 60 * 1000;
const WINDOW_SINCE = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_UNTIL = new Date('2026-09-08T00:00:00.000Z');

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('sweep-eligibility');

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
  await client.campaign.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.adAccount.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  // Por último: tudo acima referencia as organizações e integrações dos inquilinos.
  await removeTenant(client, SUFFIX);
}

type Fixture = {
  organizationId: string;
  accountId: string;
  integrationId: string;
  deletedOrganizationId: string;
  onlyDetachedOrganizationId: string;
  ids: {
    viva: string;
    tokenVencido: string;
    desvinculada: string;
    congelada: string;
    congelamentoAgendado: string;
    excluida: string;
    soDesvinculada: string;
  };
  ads: { viva: string; desvinculada: string };
};

async function seed(client: PrismaService): Promise<Fixture> {
  await cleanup(client);

  const tenant = await ensureTenant(client, SUFFIX);
  const deleted = await ensureTenant(client, `${SUFFIX}-excluida`);
  const onlyDetached = await ensureTenant(client, `${SUFFIX}-so-desvinculada`);

  await client.organization.update({
    where: { id: deleted.organizationId },
    data: { deletedAt: new Date() },
  });

  const expired = await client.integration.create({
    data: {
      id: `${SUFFIX}-int-vencida`,
      accountId: tenant.accountId,
      organizationId: tenant.organizationId,
      provider: 'meta',
      providerType: 'META',
      accessToken: 'token-de-teste',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      status: 'TOKEN_EXPIRED',
    },
  });

  const conta = async (
    name: string,
    owner: { accountId: string; organizationId: string },
    data: { integrationId: string | null; frozenAt?: Date },
  ) => {
    const created = await client.adAccount.create({
      data: {
        id: `${SUFFIX}-conta-${name}`,
        accountId: owner.accountId,
        organizationId: owner.organizationId,
        platform: 'META',
        externalAccountId: `${SUFFIX}-${name}-ext`,
        name,
        currency: 'BRL',
        timezone: 'America/Sao_Paulo',
        ...data,
      },
    });

    return created.id;
  };

  const ids = {
    viva: await conta('viva', tenant, { integrationId: tenant.integrationId }),
    tokenVencido: await conta('token-vencido', tenant, {
      integrationId: expired.id,
    }),
    desvinculada: await conta('desvinculada', tenant, { integrationId: null }),
    congelada: await conta('congelada', tenant, {
      integrationId: tenant.integrationId,
      frozenAt: new Date(Date.now() - DIA),
    }),
    // Data futura é agendamento: o cliente pagou o período, nada é cortado.
    congelamentoAgendado: await conta('congelamento-agendado', tenant, {
      integrationId: tenant.integrationId,
      frozenAt: new Date(Date.now() + 30 * DIA),
    }),
    excluida: await conta('excluida', deleted, {
      integrationId: deleted.integrationId,
    }),
    soDesvinculada: await conta('so-desvinculada', onlyDetached, {
      integrationId: null,
    }),
  };

  const anuncio = async (name: string, adAccountId: string) => {
    const campaign = await client.campaign.create({
      data: {
        id: `${SUFFIX}-campanha-${name}`,
        adAccountId,
        organizationId: tenant.organizationId,
        integrationId: tenant.integrationId,
        platform: 'META',
        externalCampaignId: `${SUFFIX}-campanha-${name}-ext`,
        name,
        currency: 'BRL',
      },
    });

    const ad = await client.ad.create({
      data: {
        id: `${SUFFIX}-anuncio-${name}`,
        accountId: tenant.accountId,
        organizationId: tenant.organizationId,
        adAccountId,
        // Histórico: a coluna guarda a credencial de quando o anúncio foi lido.
        integrationId: tenant.integrationId,
        platform: 'META',
        externalAdId: `${SUFFIX}-anuncio-${name}-ext`,
        campaignId: campaign.id,
        name,
        lineageId: `${SUFFIX}-anuncio-${name}`,
      },
    });

    return ad.id;
  };

  return {
    organizationId: tenant.organizationId,
    accountId: tenant.accountId,
    integrationId: tenant.integrationId,
    deletedOrganizationId: deleted.organizationId,
    onlyDetachedOrganizationId: onlyDetached.organizationId,
    ids,
    ads: {
      viva: await anuncio('viva', ids.viva),
      desvinculada: await anuncio('desvinculada', ids.desvinculada),
    },
  };
}

/** Só as linhas deste spec — o banco pode ter outras. */
function ours(values: string[]): string[] {
  return values.filter((value) => value.startsWith(SUFFIX)).sort();
}

describe('quem os jobs varrem — as consultas no banco', () => {
  it('o sync só lista conta de credencial viva, não congelada, de organização que existe', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    const repo = new AdAccountsSyncPrismaRepository(prisma);

    const listed = await repo.listSyncable();

    expect(ours(listed.map((account) => account.id))).toEqual(
      [fixture.ids.viva, fixture.ids.congelamentoAgendado].sort(),
    );
  }, 30_000);

  it('o rebind enxerga também a conta presa a credencial vencida', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    const repo = new AdAccountsSyncPrismaRepository(prisma);

    const listed = await repo.listSyncable({
      organizationId: fixture.organizationId,
      credential: 'ANY_LINKED',
    });
    const vencida = await repo.findById(fixture.ids.tokenVencido);

    expect(ours(listed.map((account) => account.id))).toEqual(
      [
        fixture.ids.viva,
        fixture.ids.tokenVencido,
        fixture.ids.congelamentoAgendado,
      ].sort(),
    );
    // É por este campo que o worker pula antes de gastar chamada.
    expect(vencida?.integrationStatus).toBe('TOKEN_EXPIRED');
  }, 30_000);

  it('a descoberta não religa conta desvinculada; o rebind religa', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    const repo = new AdAccountsSyncPrismaRepository(prisma);
    const discovered = {
      organizationId: fixture.organizationId,
      accountId: fixture.accountId,
      platform: 'META' as const,
      externalAccountId: `${SUFFIX}-desvinculada-ext`,
      name: 'desvinculada, renomeada',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      integrationId: fixture.integrationId,
    };

    const byDiscovery = await repo.upsertDiscovered(discovered, {
      relinkDetached: false,
    });
    const afterDiscovery = await prisma.adAccount.findUnique({
      where: { id: fixture.ids.desvinculada },
    });

    expect(byDiscovery).toEqual({
      id: fixture.ids.desvinculada,
      created: false,
      rebound: false,
    });
    expect(afterDiscovery?.integrationId).toBeNull();
    // O cadastro continua acompanhando a plataforma.
    expect(afterDiscovery?.name).toBe('desvinculada, renomeada');

    const byRebind = await repo.upsertDiscovered(discovered);
    const afterRebind = await prisma.adAccount.findUnique({
      where: { id: fixture.ids.desvinculada },
    });

    expect(byRebind.rebound).toBe(true);
    expect(afterRebind?.integrationId).toBe(fixture.integrationId);
  }, 30_000);

  it('scoring e desperdício só pegam conta que o sync lê', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    const expected = [
      fixture.ids.viva,
      fixture.ids.congelamentoAgendado,
    ].sort();

    const scoring = await new AdScoringTargetsPrismaRepository(
      prisma,
    ).listAccountsToScore();
    const waste = await new WasteTargetsPrismaRepository(
      prisma,
    ).listAccountsToDetect();

    expect(ours(scoring.map((item) => item.adAccountId))).toEqual(expected);
    expect(ours(waste.map((item) => item.adAccountId))).toEqual(expected);
  }, 30_000);

  it('a geração só passa por organização com conta viva; o ciclo de vida, por qualquer conta', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    // `listOrganizationsTo*` não lê score: o port de leitura não é chamado.
    const repo = new RecommendationTargetsPrismaRepository(prisma, {} as never);

    const toGenerate = ours(await repo.listOrganizationsToGenerate());
    const withAccounts = ours(await repo.listOrganizationsWithAdAccounts());

    expect(toGenerate).toEqual([fixture.organizationId]);
    expect(withAccounts).toEqual(
      [fixture.organizationId, fixture.onlyDetachedOrganizationId].sort(),
    );
  }, 30_000);

  it('a régua não carimba anúncio de conta desvinculada, nem o conta contra o teto', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const client = prisma;
    const fixture = await seed(client);
    const repo = new AnalysisScopePrismaRepository(client);

    const stamped = async () =>
      ours(
        (
          await client.ad.findMany({
            where: {
              organizationId: fixture.organizationId,
              analysisEligibleAt: { not: null },
            },
            select: { id: true },
          })
        ).map((row) => row.id),
      );

    // Sem teto: o caminho Prisma (`selectAll`).
    await repo.markEligible({
      organizationId: fixture.organizationId,
      limit: null,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      now: new Date(),
    });
    expect(await stamped()).toEqual([fixture.ads.viva]);

    // Com teto: o caminho SQL (`selectCore`/`selectRotation`), onde o filtro é
    // o fragmento cru e o status da integração é comparado como enum.
    await repo.markEligible({
      organizationId: fixture.organizationId,
      limit: 20,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      now: new Date(),
    });
    expect(await stamped()).toEqual([fixture.ads.viva]);

    expect(await repo.countEligible(fixture.organizationId)).toBe(1);
    // O anúncio da conta desvinculada está fora da análise, mas não por teto.
    expect(await repo.countExcluded(fixture.organizationId)).toBe(0);
    expect(
      await repo.countRotationQueue({
        organizationId: fixture.organizationId,
        since: WINDOW_SINCE,
        until: WINDOW_UNTIL,
      }),
    ).toBe(0);
  }, 30_000);

  it('o retrato de acesso lê a assinatura, e o carimbo de fechamento é gravado uma vez só', async () => {
    if (!prisma) return expect(reason).toBeTruthy();
    const fixture = await seed(prisma);
    const repo = new OrganizationSweepPrismaRepository(prisma);

    await prisma.organizationSubscription.update({
      where: { organizationId: fixture.organizationId },
      data: { status: 'EXPIRED' },
    });

    const snapshots = await repo.findSnapshots(
      [fixture.organizationId, fixture.deletedOrganizationId],
      new Date(),
    );
    const snapshot = snapshots.find(
      (row) => row.organizationId === fixture.organizationId,
    );
    const deleted = snapshots.find(
      (row) => row.organizationId === fixture.deletedOrganizationId,
    );

    expect(snapshot).toMatchObject({
      deletedAt: null,
      accessClosedAt: null,
      subscription: { status: 'EXPIRED', contract: null },
      accounts: [],
    });
    expect(deleted?.deletedAt).not.toBeNull();

    const primeiro = new Date('2026-09-10T00:00:00.000Z');
    await repo.markAccessClosed([fixture.organizationId], primeiro);
    // Reobservar não reinicia a janela.
    await repo.markAccessClosed(
      [fixture.organizationId],
      new Date('2026-09-11T00:00:00.000Z'),
    );

    const [marcado] = await repo.findSnapshots(
      [fixture.organizationId],
      new Date(),
    );
    expect(marcado.accessClosedAt).toEqual(primeiro);

    await repo.clearAccessClosed([fixture.organizationId]);

    const [limpo] = await repo.findSnapshots(
      [fixture.organizationId],
      new Date(),
    );
    expect(limpo.accessClosedAt).toBeNull();
  }, 30_000);
});
