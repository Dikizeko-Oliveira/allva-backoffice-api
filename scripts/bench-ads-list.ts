/* eslint-disable no-console */
/**
 * Gate de desempenho de A2-S2 (§17.2): `GET /ads` com p95 < 400 ms sobre 10k
 * anúncios, com filtro e ordenação combinados.
 *
 * Mede a **consulta**, não o HTTP: o que o gate protege é a decisão de servir a
 * tela principal por denormalização em `ads` em vez de join na série. Latência
 * de rede e serialização entram depois, e não é isso que a decisão arquitetural
 * arrisca.
 *
 *   pnpm seed:ads-v2 -- --ads=10000 --days=14
 *   pnpm bench:ads
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const ITERATIONS = 30;
const P95_BUDGET_MS = 400;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

type Scenario = {
  name: string;
  run: (organizationId: string) => Promise<unknown>;
};

const SCENARIOS: Scenario[] = [
  {
    // O padrão da tela: ordena pelo que dá para interromper hoje.
    name: 'sortBy=avoidableDaily (padrão)',
    run: (organizationId) =>
      prisma.ad.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: [{ avoidableDailyAmountBase: 'desc' }, { id: 'desc' }],
        take: 25,
      }),
  },
  {
    // O caso do gate: filtro **e** ordenação combinados, com os pisos de §12.4
    // aplicados em WHERE — é para isso que confiança e cobertura são
    // denormalizadas em `ads`.
    name: 'scoreBelow + piso de confiança + sortBy=aiScore',
    run: (organizationId) =>
      prisma.ad.findMany({
        where: {
          organizationId,
          archivedAt: null,
          currentAiScore: { lt: 50 },
          currentScoreConfidence: { gte: 0.4 },
          currentScoreCoverage: { gte: 0.6 },
        },
        orderBy: [{ currentAiScore: 'asc' }, { id: 'asc' }],
        take: 25,
      }),
  },
  {
    name: 'hasOpenWaste + sortBy=scoreDelta',
    run: (organizationId) =>
      prisma.ad.findMany({
        where: { organizationId, archivedAt: null, openWasteCount: { gt: 0 } },
        orderBy: [{ scoreDelta7d: 'asc' }, { id: 'asc' }],
        take: 25,
      }),
  },
  {
    name: 'filtro por campanha + platform',
    run: async (organizationId) => {
      const campaign = await prisma.campaign.findFirst({
        where: { organizationId },
        select: { id: true },
      });
      return prisma.ad.findMany({
        where: {
          organizationId,
          archivedAt: null,
          campaignId: campaign?.id,
          platform: 'META',
        },
        orderBy: [{ avoidableDailyAmountBase: 'desc' }, { id: 'desc' }],
        take: 25,
      });
    },
  },
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

async function main() {
  const organization = await prisma.organization.findFirst({
    where: { adAccounts: { some: {} } },
    select: { id: true },
  });

  if (!organization)
    throw new Error('Nenhuma organização com contas. Rode o seed.');

  const total = await prisma.ad.count({
    where: { organizationId: organization.id },
  });
  console.log(`Anúncios na organização: ${total}`);
  if (total < 10_000) {
    console.log(
      `⚠️  Menos de 10.000 anúncios. O gate de §17.2 exige 10k: ` +
        `pnpm seed:ads-v2 -- --ads=10000`,
    );
  }

  let failed = false;
  for (const scenario of SCENARIOS) {
    // Descarta a primeira: mede plano frio de query, não a consulta.
    await scenario.run(organization.id);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = process.hrtime.bigint();
      await scenario.run(organization.id);
      samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    }

    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const verdict = p95 < P95_BUDGET_MS ? '✅' : '❌';
    if (p95 >= P95_BUDGET_MS) failed = true;

    console.log(
      `${verdict} ${scenario.name.padEnd(46)} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
    );
  }

  if (failed) {
    console.error(
      `\n❌ p95 acima de ${P95_BUDGET_MS} ms — o gate de §17.2 falhou.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\n✅ Todos os cenários abaixo de ${P95_BUDGET_MS} ms (p95).`);
  }
}

main()
  .catch((error) => {
    console.error('❌ benchmark falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
