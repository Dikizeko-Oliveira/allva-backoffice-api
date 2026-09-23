/**
 * Provisiona a organização das contas que nasceram antes de o cadastro passar a
 * criá-la.
 *
 * Uso:
 *   pnpm run provision:organizations -- --dry-run
 *   pnpm run provision:organizations
 *
 * Por que existe:
 *   O produto é organization-first — `ads`, `integrations`, waste e
 *   recomendações são escopados por `organization_id` —, mas o cadastro só
 *   passou a provisionar a organização agora. Toda conta self-serve criada antes
 *   disso está num estado que nenhuma tela sabe atender. Este script cura o
 *   passivo; o cadastro cuida do fluxo novo.
 *
 *   A terceira perna cura a **assinatura da organização**. Só o provisionamento
 *   de lead `CLOSED_WON` gravava `organization_subscriptions`, e é essa linha que
 *   `findPlanTypeByOrganizationId` lê para responder às dezesseis guardas de
 *   `ENFORCED_FEATURE_KEYS`. Sem ela o plano resolve para nulo, `planAllows`
 *   fecha na dúvida, e o produto recusa com `PLAN_FEATURE_NOT_INCLUDED` o que o
 *   cliente contratou — foi assim que vincular conta de anúncios da Meta parou
 *   de funcionar. O plano herdado é o da assinatura de conta do dono, quando ela
 *   existe; senão, o teste gratuito.
 *
 * Segurança:
 *   - Idempotente. Conta que já alcança uma organização (participação ativa ou
 *     posse) é pulada, e rodar duas vezes não produz duplicata.
 *   - Uma transação por conta: uma falha isolada não derruba o lote nem deixa
 *     organização sem participação OWNER.
 *   - `--dry-run` não escreve nada.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { resolveDefaultOrganizationName } from '../src/modules/provisioning/domain/organization-name';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  try {
    const accounts = await prisma.account.findMany({
      // Só cliente. Conta de plataforma nunca tem organização — sem este
      // filtro, cada operador ganhava uma organização com teste gratuito, que
      // é a conta híbrida que o produto recusa em toda porta HTTP.
      where: { role: 'USER' },
      select: { id: true, name: true, email: true },
      orderBy: { createdAt: 'asc' },
    });

    const freePlan = await prisma.plan.findUnique({ where: { type: 'FREE' } });

    if (!freePlan) {
      throw new Error(
        'Tabela `plans` sem o FREE. Rode `pnpm run seed:plans` antes deste script.',
      );
    }

    /**
     * O plano pago que a conta já tem, quando tem.
     *
     * `organization_subscriptions` carrega o portão de plano; a cobrança mora na
     * assinatura de conta. Curar tudo como teste gratuito daria 14 dias a quem
     * paga há meses — e, pior, poria no Individual as capacidades do
     * Profissional, porque o FREE espelha o PRO. Os estados listados são os que
     * `mapBillingToAccess` trata como acesso vivo (`PAST_DUE` está em graça).
     */
    const paidByAccount = new Map<string, string>();

    for (const subscription of await prisma.subscription.findMany({
      where: {
        billingStatus: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        plan: { type: { not: 'FREE' } },
      },
      select: { accountId: true, planId: true },
      orderBy: { createdAt: 'asc' },
    })) {
      paidByAccount.set(subscription.accountId, subscription.planId);
    }

    const planFor = (ownerAccountId: string) => {
      const now = new Date();
      const paidPlanId = paidByAccount.get(ownerAccountId);

      if (paidPlanId) {
        // Sem `trialEndsAt`: quem paga não está em teste, e o `lte` de
        // `listExpiredTrials` nunca casa com nulo.
        return {
          planId: paidPlanId,
          status: 'ACTIVE' as const,
          trialStartedAt: now,
          trialEndsAt: null,
        };
      }

      return {
        planId: freePlan.id,
        status: 'TRIALING' as const,
        trialStartedAt: now,
        trialEndsAt: new Date(
          now.getTime() + (freePlan.trialDays ?? 14) * 24 * 60 * 60 * 1000,
        ),
      };
    };

    let provisioned = 0;
    let skipped = 0;
    let failed = 0;

    for (const account of accounts) {
      // A mesma pergunta de `OrganizationProvisioningService`: participação
      // ativa primeiro, posse depois. Congelado conta como pertencente — criar
      // organização para quem perdeu a vaga contornaria o teto de assentos.
      const membership = await prisma.organizationUser.findFirst({
        where: {
          accountId: account.id,
          status: 'ACTIVE',
          deletedAt: null,
          organization: { deletedAt: null },
        },
        select: { organizationId: true },
      });

      const owned = membership
        ? null
        : await prisma.organization.findFirst({
            where: { ownerId: account.id, deletedAt: null },
            select: { id: true },
          });

      if (membership || owned) {
        skipped += 1;
        continue;
      }

      const name = resolveDefaultOrganizationName({
        name: account.name,
        email: account.email,
      });

      if (dryRun) {
        console.log(`[dry-run] ${account.id} -> "${name}"`);
        provisioned += 1;
        continue;
      }

      try {
        await prisma.$transaction(async (tx) => {
          const organizationId = randomUUID();

          await tx.organization.create({
            data: { id: organizationId, ownerId: account.id, name },
          });
          await tx.organizationUser.create({
            data: {
              id: randomUUID(),
              organizationId,
              accountId: account.id,
              role: 'OWNER',
              status: 'ACTIVE',
            },
          });
          await tx.organizationAdsSettings.create({ data: { organizationId } });
          await tx.organizationSubscription.create({
            data: {
              id: randomUUID(),
              organizationId,
              ...planFor(account.id),
            },
          });
          await tx.auditLog.createMany({
            data: [
              {
                id: randomUUID(),
                event: 'organization.created',
                entityType: 'organization',
                entityId: organizationId,
                actorId: account.id,
                organizationId,
                metadata: { name, source: 'backfill' },
              },
              {
                id: randomUUID(),
                event: 'owner.created',
                entityType: 'organization_user',
                entityId: account.id,
                actorId: account.id,
                organizationId,
                metadata: { name, source: 'backfill', role: 'OWNER' },
              },
            ],
          });

          console.log(`${account.id} -> ${organizationId} "${name}"`);
        });

        provisioned += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `FALHOU ${account.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Segunda perna: organizações que existem mas não têm dono efetivo. Roda
    // depois do provisionamento para também alcançar o que acabou de nascer.
    const ownerless = await prisma.organization.findMany({
      where: {
        deletedAt: null,
        users: {
          none: { role: 'OWNER', status: 'ACTIVE', deletedAt: null },
        },
      },
      select: { id: true, name: true, ownerId: true },
    });

    let ownersHealed = 0;

    for (const organization of ownerless) {
      if (dryRun) {
        console.log(
          `[dry-run] OWNER ausente em ${organization.id} ("${organization.name}") -> ${organization.ownerId}`,
        );
        ownersHealed += 1;
        continue;
      }

      try {
        // A participação pode existir com outro papel ou status — o `@@unique`
        // em (organization_id, account_id) recusaria um `create`. Promover a do
        // `owner_id` é a cura; criar é o caso em que ela nunca existiu.
        await prisma.organizationUser.upsert({
          where: {
            organizationId_accountId: {
              organizationId: organization.id,
              accountId: organization.ownerId,
            },
          },
          update: { role: 'OWNER', status: 'ACTIVE', deletedAt: null },
          create: {
            id: randomUUID(),
            organizationId: organization.id,
            accountId: organization.ownerId,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        });

        await prisma.auditLog.create({
          data: {
            id: randomUUID(),
            event: 'owner.created',
            entityType: 'organization_user',
            entityId: organization.ownerId,
            actorId: organization.ownerId,
            organizationId: organization.id,
            metadata: {
              name: organization.name,
              source: 'backfill',
              role: 'OWNER',
            },
          },
        });

        console.log(
          `OWNER curado em ${organization.id} ("${organization.name}")`,
        );
        ownersHealed += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `FALHOU OWNER ${organization.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Terceira perna: organizações sem assinatura. Roda por último para também
    // alcançar as que acabaram de nascer aqui — o `create` acima já as cobre, e
    // esta consulta simplesmente não as encontra.
    const planless = await prisma.organization.findMany({
      where: { deletedAt: null, subscription: { is: null } },
      select: { id: true, name: true, ownerId: true },
    });

    let plansHealed = 0;

    for (const organization of planless) {
      const data = planFor(organization.ownerId);

      if (dryRun) {
        console.log(
          `[dry-run] plano ausente em ${organization.id} ("${organization.name}") -> ${data.status}`,
        );
        plansHealed += 1;
        continue;
      }

      try {
        await prisma.organizationSubscription.create({
          data: { id: randomUUID(), organizationId: organization.id, ...data },
        });

        console.log(
          `plano curado em ${organization.id} ("${organization.name}") -> ${data.status}`,
        );
        plansHealed += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `FALHOU PLANO ${organization.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.log(
      `\ncontas=${accounts.length} provisionadas=${provisioned} puladas=${skipped} owners_curados=${ownersHealed} planos_curados=${plansHealed} falhas=${failed}${
        dryRun ? ' (dry-run)' : ''
      }`,
    );

    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
