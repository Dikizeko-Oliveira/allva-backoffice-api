/**
 * Semente mínima de desenvolvimento: conta + organização (com plano) + integração.
 *
 * O `seed:ads-v2` pressupõe que elas existam (o fluxo normal é o signup criá-las).
 * Depois de um `migrate reset` o banco fica sem nenhuma, e tanto o seed quanto os
 * testes de integração pulam por falta de fixture.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const existing = await prisma.organization.findFirst({
    select: { id: true },
  });
  if (existing) {
    console.log('Organização já existe:', existing.id);
    return;
  }

  const account = await prisma.account.create({
    data: {
      name: 'Dev Owner',
      email: `dev-owner-${Date.now()}@allva.local`,
      // Hash inválido de propósito: esta conta não faz login, só ancora as FKs.
      passwordHash: 'dev-bootstrap-not-a-real-hash',
      emailVerified: true,
    },
  });

  const organization = await prisma.organization.create({
    data: { ownerId: account.id, name: 'Dev Org', baseCurrency: 'BRL' },
  });

  await prisma.organizationAdsSettings.create({
    data: { organizationId: organization.id },
  });

  // `owner_id` nomeia o criador; quem o RBAC lê é a participação. Sem esta
  // linha a organização de desenvolvimento nasce com dono no papel e ninguém
  // com permissão — e `test/integration/organization-ads-settings.spec.ts`
  // reprova, que foi como esta ausência apareceu.
  await prisma.organizationUser.create({
    data: {
      organizationId: organization.id,
      accountId: account.id,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });

  // A quarta perna, pela mesma razão. `findPlanTypeByOrganizationId` lê esta
  // linha, e sem ela `planAllows` fecha na dúvida: a organização de
  // desenvolvimento existiria com todas as guardas de plano negando tudo, que é
  // o oposto do que um ambiente de desenvolvimento precisa ser.
  const freePlan = await prisma.plan.findUnique({ where: { type: 'FREE' } });

  if (!freePlan) {
    throw new Error(
      'Tabela `plans` sem o FREE. Rode `pnpm run seed:plans` antes deste script.',
    );
  }

  const now = new Date();

  await prisma.organizationSubscription.create({
    data: {
      organizationId: organization.id,
      planId: freePlan.id,
      status: 'TRIALING',
      trialStartedAt: now,
      trialEndsAt: new Date(
        now.getTime() + (freePlan.trialDays ?? 14) * 24 * 60 * 60 * 1000,
      ),
    },
  });

  const integration = await prisma.integration.create({
    data: {
      accountId: account.id,
      organizationId: organization.id,
      provider: 'meta',
      providerType: 'META',
      accessToken: 'dev-bootstrap-token',
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });

  console.log('conta:', account.id);
  console.log('organização:', organization.id);
  console.log('integração:', integration.id);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
