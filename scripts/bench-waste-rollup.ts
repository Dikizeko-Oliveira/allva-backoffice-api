/**
 * Gate de desempenho de A2-S5: `/waste/rollup` com **p95 < 500 ms sobre 100k
 * anúncios**.
 *
 * O gate mede a consulta que a subconsulta pré-agregada de §10.8 tornou
 * correta — e é justamente ela que dá o custo. Agrupar por `a."id"` antes de
 * subir para a campanha impede a multiplicação do join 1:N, mas obriga o
 * Postgres a materializar uma linha por anúncio afetado antes de agregar. Se
 * essa forma não couber no orçamento, a alternativa **não** é voltar à query
 * errada: é um índice, ou um read model materializado. O número existe para
 * essa conversa acontecer com dado.
 *
 *   pnpm seed:ads-v2 -- --ads=100000 --days=14
 *   pnpm bench:waste
 *
 * **O bench semeia os próprios achados.** Sem eles o `JOIN` com `open_waste` não
 * casa nada e a consulta responde em três milissegundos — um número verdadeiro
 * sobre uma pergunta que ninguém fez. E os achados são semeados em **rajadas de
 * 1 a 3 por anúncio**, que é exatamente a cardinalidade do lado N que a
 * subconsulta existe para não multiplicar: medir com um achado por anúncio
 * esconderia o custo do agrupamento.
 *
 * A semeadura é limpa ao final, inclusive em falha.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { WasteReadPrismaRepository } from '../src/modules/waste/infrastructure/database/prisma/waste-read-prisma.repository';
import type { PrismaService } from '../src/shared/infrastructure/database/prisma/prisma.service';
import type { WasteRollupGroupBy } from '../src/modules/waste/domain/ports/waste-read.repository';

const ITERATIONS = 20;
const P95_BUDGET_MS = 500;
const TARGET_ADS = 100_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const repository = new WasteReadPrismaRepository(
  prisma as unknown as PrismaService,
);

const GROUPINGS: WasteRollupGroupBy[] = [
  'campaign',
  'adSet',
  'platform',
  'adAccount',
];

const BENCH_FINGERPRINT_PREFIX = 'bench-waste-rollup';
/** Fração dos anúncios com desperdício aberto — a proporção de uma conta real. */
const AFFECTED_SHARE = 0.35;
const INSERT_CHUNK = 2_000;

/**
 * Semeia de 1 a 3 achados abertos por anúncio afetado, com a denormalização
 * correspondente em `ads`.
 *
 * O `max` de §10.6 é gravado na coluna do anúncio, como o worker faria: é essa
 * coluna que o rollup soma, e semear as duas coisas de forma incoerente mediria
 * a consulta certa sobre um estado que a detecção nunca produziria.
 */
async function seedFindings(organizationId: string): Promise<number> {
  const ads = await prisma.ad.findMany({
    where: { organizationId, archivedAt: null },
    select: { id: true, accountId: true },
  });

  const affected = ads.filter((_, index) => index % 100 < AFFECTED_SHARE * 100);
  const types = ['ZERO_CONVERSIONS', 'LOW_CTR', 'CREATIVE_FATIGUE'] as const;
  const rows: Array<Record<string, unknown>> = [];
  const denormalized: Array<{
    id: string;
    amount: number;
    daily: number;
    count: number;
  }> = [];

  affected.forEach((ad, index) => {
    const findings = (index % 3) + 1;
    let maxAmount = 0;
    let maxDaily = 0;

    for (let i = 0; i < findings; i += 1) {
      const amount = 1_400 / (i + 1);
      const daily = 100 / (i + 1);
      maxAmount = Math.max(maxAmount, amount);
      maxDaily = Math.max(maxDaily, daily);

      rows.push({
        adId: ad.id,
        organizationId,
        accountId: ad.accountId,
        findingKind: 'WASTE',
        type: types[i],
        priority: i === 0 ? 'CRITICAL' : 'MEDIUM',
        windowDays: 14,
        incurredAmount: amount,
        incurredAmountBase: amount,
        avoidableDailyAmount: daily,
        avoidableDailyBase: daily,
        currency: 'BRL',
        baseCurrency: 'BRL',
        diagnosis: 'bench',
        evidence: {},
        evidenceSufficiency: 'SUFFICIENT',
        scopeLevel: 'AD',
        dataMaturity: 'MATURE',
        detectorVersion: 'v2.0.0',
        detectorProfileVersion: 'waste-thresholds-v1',
        fingerprint: `${BENCH_FINGERPRINT_PREFIX}:${ad.id}:${types[i]}`,
      });
    }

    denormalized.push({
      id: ad.id,
      amount: maxAmount,
      daily: maxDaily,
      count: findings,
    });
  });

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await prisma.wasteItem.createMany({
      data: rows.slice(i, i + INSERT_CHUNK) as never,
    });
  }

  for (let i = 0; i < denormalized.length; i += INSERT_CHUNK) {
    const chunk = denormalized.slice(i, i + INSERT_CHUNK);
    const values = chunk
      .map(
        (row, index) =>
          `($${index * 4 + 1}, $${index * 4 + 2}::numeric, $${index * 4 + 3}::numeric, $${index * 4 + 4}::int)`,
      )
      .join(', ');

    await prisma.$executeRawUnsafe(
      `UPDATE "ads" AS a SET "open_waste_amount" = v.amount,
              "open_waste_amount_base" = v.amount,
              "open_waste_currency" = 'BRL',
              "avoidable_daily_amount_base" = v.daily,
              "open_waste_count" = v.count,
              "waste_as_of" = NOW()
         FROM (VALUES ${values}) AS v(id, amount, daily, count)
        WHERE a."id" = v.id`,
      ...chunk.flatMap((row) => [row.id, row.amount, row.daily, row.count]),
    );
  }

  return rows.length;
}

async function clearFindings(): Promise<void> {
  await prisma.wasteItem.deleteMany({
    where: { fingerprint: { startsWith: BENCH_FINGERPRINT_PREFIX } },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "ads" SET "open_waste_amount" = 0, "open_waste_amount_base" = 0,
            "open_waste_currency" = NULL, "avoidable_daily_amount_base" = 0,
            "open_waste_count" = 0, "waste_as_of" = NULL
      WHERE "open_waste_count" > 0`,
  );
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

async function measure(
  name: string,
  run: () => Promise<unknown>,
): Promise<boolean> {
  // Descarta a primeira: mede plano frio de query, não a consulta.
  await run();

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }

  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const passed = p95 < P95_BUDGET_MS;

  console.log(
    `${passed ? '✅' : '❌'} ${name.padEnd(40)} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
  );

  return passed;
}

async function main() {
  const organization = await prisma.organization.findFirst({
    where: { adAccounts: { some: {} } },
    select: { id: true },
  });

  if (!organization) {
    throw new Error('Nenhuma organização com contas. Rode o seed.');
  }

  const ads = await prisma.ad.count({
    where: { organizationId: organization.id },
  });

  if (ads < TARGET_ADS) {
    console.log(
      `⚠️  ${ads} anúncios — o gate de A2-S5 exige ${TARGET_ADS}: ` +
        `pnpm seed:ads-v2 -- --ads=100000`,
    );
  }

  await clearFindings();
  const seeded = await seedFindings(organization.id);
  console.log(`Anúncios: ${ads} · achados abertos semeados: ${seeded}\n`);

  let failed = false;

  for (const groupBy of GROUPINGS) {
    const passed = await measure(`rollup groupBy=${groupBy}`, () =>
      repository.rollup({
        organizationId: organization.id,
        groupBy,
        windowDays: 14,
        limit: 25,
      }),
    );
    if (!passed) failed = true;
  }

  // O resumo compartilha a subconsulta com o rollup: se ela custar, custa nos
  // dois, e medir só um esconderia metade do problema.
  const summaryPassed = await measure('summary', () =>
    repository.summary({ organizationId: organization.id, windowDays: 14 }),
  );
  if (!summaryPassed) failed = true;

  const byAdPassed = await measure('by-ad (primeira página)', () =>
    repository.byAd({ organizationId: organization.id, limit: 25 }),
  );
  if (!byAdPassed) failed = true;

  if (failed) {
    console.error(`\n❌ p95 acima do orçamento de ${P95_BUDGET_MS} ms.`);
    process.exitCode = 1;
  } else {
    console.log(`\n✅ Tudo abaixo de ${P95_BUDGET_MS} ms de p95.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // A limpeza roda inclusive em falha: um bench que deixa 100 mil achados
  // sintéticos no banco de desenvolvimento contamina toda medição seguinte —
  // e a próxima pessoa não teria como saber de onde eles vieram.
  .finally(async () => {
    await clearFindings().catch(() => undefined);
    await prisma.$disconnect();
  });
