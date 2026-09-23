/**
 * Projeta `PLAN_SPECS` + `PLAN_FEATURE_SPECS` no banco.
 *
 *   pnpm seed:plans
 *
 * **Idempotente e re-executável.** É assim que uma alteração de vitrine chega em
 * produção: edita-se `src/modules/plans/domain/plan-catalog.ts` e roda-se de
 * novo. Fazer isto por INSERT dentro de uma migração significaria que corrigir o
 * texto de uma feature exige uma nova migração, e que o catálogo real vira algo
 * que só se descobre lendo `.sql` já aplicado.
 *
 * O plano é casado por `type` (que é `@unique`), e a feature por
 * `(planId, key)` — então rodar duas vezes atualiza, nunca duplica. Features que
 * saírem do catálogo são removidas do plano, senão uma linha aposentada
 * continuaria na landing para sempre.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import {
  PLAN_FEATURE_SPECS,
  PLAN_SPECS,
  resolvePlanFeatures,
} from 'src/modules/plans/domain/plan-catalog';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const catalogKeys = PLAN_FEATURE_SPECS.map((spec) => spec.key);

  for (const spec of PLAN_SPECS) {
    const plan = await prisma.plan.upsert({
      where: { type: spec.type },
      // `stripePriceId` fica de fora de propósito: ele é configurado por
      // ambiente (teste e produção têm prices diferentes) e sobrescrevê-lo com
      // null aqui desligaria o checkout do plano.
      update: {
        name: spec.name,
        amount: spec.amount,
        amountAnnual: spec.amountAnnual,
        trialDays: spec.trialDays,
      },
      create: {
        type: spec.type,
        name: spec.name,
        amount: spec.amount,
        amountAnnual: spec.amountAnnual,
        trialDays: spec.trialDays,
      },
    });

    const features = resolvePlanFeatures(spec.type);

    for (const feature of features) {
      await prisma.planFeature.upsert({
        where: { planId_key: { planId: plan.id, key: feature.key } },
        update: {
          name: feature.name,
          enabled: feature.enabled,
          value: feature.value,
          description: feature.description,
          sortOrder: feature.sortOrder,
          landingHighlight: feature.landingHighlight,
        },
        create: {
          planId: plan.id,
          key: feature.key,
          name: feature.name,
          enabled: feature.enabled,
          value: feature.value,
          description: feature.description,
          sortOrder: feature.sortOrder,
          landingHighlight: feature.landingHighlight,
        },
      });
    }

    const removed = await prisma.planFeature.deleteMany({
      where: { planId: plan.id, key: { notIn: catalogKeys } },
    });

    const shown = features.filter((f) => f.enabled).length;
    // `ativas` é o que o plano inclui, `card` é o que cabe no card do plano. Os
    // dois divergem de propósito — ver `highlight` no catálogo. A tabela
    // comparativa não aparece aqui porque ela mostra sempre as 31.
    const onCard = features.filter((f) => f.landingHighlight).length;

    console.log(
      `${spec.type.padEnd(10)} ${String(spec.name).padEnd(16)} ` +
        `R$ ${String(spec.amount).padStart(5)}/mês  ` +
        `features=${features.length} ativas=${shown} ` +
        `card=${onCard} removidas=${removed.count}`,
    );
  }

  const total = await prisma.planFeature.count();
  console.log(`\nplan_features: ${total} linhas.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
