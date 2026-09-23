import 'dotenv/config';

import { Test } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { Integration } from 'src/modules/integrations/domain/entities';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import type {
  ProviderAd,
  ProviderMetricRow,
  ProviderSyncResult,
} from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { IngestAdAccountService } from 'src/modules/sync/application/services/ingest-ad-account.service';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * O gate de §17.2 do A2-S3: **ingest de uma `AdAccount` com 5k anúncios em
 * menos de 5 minutos**, e contagem de chamadas à plataforma.
 *
 * O provider é substituído por um gerador determinístico. Isso é deliberado: o
 * alvo mede o **nosso** custo — upsert em ordem de FK, normalização monetária,
 * denormalização de maturidade, guarda de recência anúncio a anúncio —, não a
 * latência do Graph. Medir com a rede dentro faria o número variar com o dia e
 * esconder exatamente a parte que temos como consertar.
 *
 * A contagem de chamadas é o outro lado do gate ("≥ 60% abaixo da v1"): o v1
 * fazia uma requisição de insights por nível (campanha, conjunto, anúncio,
 * criativo) além das listagens; a v2.0 lê **só o nível AD** e coalesce o resto.
 *
 * `pnpm bench:ingest [ads] [dias]`
 */

const ADS = Number(process.argv[2] ?? 5_000);
const DAYS = Number(process.argv[3] ?? 14);
const BENCH_EXTERNAL_ACCOUNT = 'bench-act_ingest';

type Counter = { calls: number };

function buildProviderResult(counter: Counter): ProviderSyncResult {
  counter.calls += 1;

  const ads: ProviderAd[] = [];
  const metrics: ProviderMetricRow[] = [];
  const today = new Date();

  for (let index = 0; index < ADS; index += 1) {
    const externalAdId = `bench-ad-${index}`;
    // 50 campanhas e 250 conjuntos: a proporção real de uma conta grande, e o
    // que faz o mapa de resolução de FK ter tamanho realista.
    const campaignExternalId = `bench-camp-${index % 50}`;
    const adSetExternalId = `bench-set-${index % 250}`;

    ads.push({
      externalAdId,
      adSetExternalId,
      campaignExternalId,
      creativeExternalId: `bench-cr-${index % 400}`,
      name: `Anúncio de benchmark ${index}`,
      status: index % 7 === 0 ? 'PAUSED' : 'ACTIVE',
      updatedAt: today,
    });

    for (let day = 0; day < DAYS; day += 1) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - day);

      metrics.push({
        date,
        level: 'AD',
        externalEntityId: externalAdId,
        campaignExternalId,
        adSetExternalId,
        adExternalId: externalAdId,
        creativeExternalId: `bench-cr-${index % 400}`,
        spend: 10 + (index % 90),
        impressions: 1_000 + index,
        clicks: 10 + (index % 40),
        conversions: index % 5,
        revenue: (index % 5) * 60,
      });
    }
  }

  return {
    metrics,
    campaigns: Array.from({ length: 50 }, (_, index) => ({
      externalCampaignId: `bench-camp-${index}`,
      name: `Campanha ${index}`,
      currency: 'BRL',
    })),
    adSets: Array.from({ length: 250 }, (_, index) => ({
      externalAdSetId: `bench-set-${index}`,
      campaignExternalId: `bench-camp-${index % 50}`,
      name: `Conjunto ${index}`,
    })),
    ads,
    creatives: Array.from({ length: 400 }, (_, index) => ({
      externalCreativeId: `bench-cr-${index}`,
      title: `Título ${index}`,
      body: `Corpo ${index}`,
    })),
    wasComplete: true,
  };
}

async function main(): Promise<void> {
  const counter: Counter = { calls: 0 };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AdsProviderFactory)
    .useValue({
      for: () => ({
        syncAdAccountMetrics: () =>
          Promise.resolve(buildProviderResult(counter)),
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  const ingest = app.get(IngestAdAccountService);
  const integrations = app.get(IntegrationsRepositoryInterface);

  const organization = await prisma.organization.findFirst({
    select: { id: true, ownerId: true },
  });

  if (!organization) {
    throw new Error(
      'Nenhuma organização no banco. Rode `pnpm seed:ads-v2` antes do benchmark.',
    );
  }

  // `Integration` é única por `(organização, plataforma)`: reaproveita a que já
  // existe em vez de tentar criar uma segunda e bater na unique.
  const existing = await integrations.findByAccountAndProvider(
    organization.ownerId,
    'META',
  );

  const integration =
    existing ??
    Integration.create({
      accountId: organization.ownerId,
      organizationId: organization.id,
      provider: 'meta',
      providerType: 'META',
      accessToken: 'bench-token',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

  if (!existing) await integrations.save(integration);

  const adAccount = await prisma.adAccount.upsert({
    where: {
      organizationId_platform_externalAccountId: {
        organizationId: organization.id,
        platform: 'META',
        externalAccountId: BENCH_EXTERNAL_ACCOUNT,
      },
    },
    create: {
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: 'META',
      externalAccountId: BENCH_EXTERNAL_ACCOUNT,
      name: 'Conta de benchmark',
      currency: 'BRL',
      timezone: 'America/Sao_Paulo',
      integrationId: integration.id,
      attributionWindowDays: 7,
    },
    update: { integrationId: integration.id },
    select: { id: true },
  });

  console.log(
    `bench: ${ADS} anúncios × ${DAYS} dias = ${ADS * DAYS} linhas de série\n`,
  );

  for (const pass of ['frio (tudo novo)', 'quente (tudo upsert)']) {
    counter.calls = 0;
    const startedAt = Date.now();

    const outcome = await ingest.execute({
      adAccountId: adAccount.id,
      trigger: 'MANUAL',
      ctx: createRootJobContext(),
      forceFullScan: true,
    });

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `${pass.padEnd(22)} ${(elapsedMs / 1000).toFixed(1)}s · ` +
        `ads=${outcome.adsUpserted} linhas=${outcome.metricRows} ` +
        `chamadas=${counter.calls} · completa=${outcome.wasComplete} ` +
        `saúde=${outcome.health}`,
    );

    if (elapsedMs > 300_000) {
      console.error(`FALHOU o alvo de §17.2 (< 5 min): ${elapsedMs} ms`);
      process.exitCode = 1;
    }
  }

  await cleanup(prisma, adAccount.id, existing ? null : integration.id);
  await app.close();
  process.exit(process.exitCode ?? 0);
}

/** Não deixa lixo no banco de desenvolvimento: o benchmark é reexecutável. */
async function cleanup(
  prisma: PrismaService,
  adAccountId: string,
  /** `null` quando a credencial já existia — ela não é lixo do benchmark. */
  integrationId: string | null,
): Promise<void> {
  await prisma.adMetricSnapshot.deleteMany({ where: { adAccountId } });
  await prisma.ad.deleteMany({ where: { adAccountId } });
  await prisma.adSet.deleteMany({ where: { adAccountId } });
  await prisma.campaign.deleteMany({ where: { adAccountId } });
  await prisma.creative.deleteMany({ where: { adAccountId } });
  await prisma.syncQuarantine.deleteMany({ where: { adAccountId } });
  await prisma.syncOperation.deleteMany({ where: { adAccountId } });
  await prisma.adAccount.deleteMany({ where: { id: adAccountId } });
  if (integrationId) {
    await prisma.integration.deleteMany({ where: { id: integrationId } });
  }
}

main().catch((error: Error) => {
  console.error('bench falhou:', error.message);
  process.exit(1);
});
