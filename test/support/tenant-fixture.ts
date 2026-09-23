import type { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';

/**
 * O inquilino mínimo que um teste de integração precisa — **criado, não
 * encontrado**.
 *
 * ## O defeito que isto corrige
 *
 * Os specs procuravam uma organização com `findFirst` e degradavam para um
 * `expect('sem fixture').toBeTruthy()` quando não achavam. Na máquina de quem
 * tem o banco semeado, funcionava. No CI — que roda `migrate deploy` num banco
 * **vazio** e nada mais — não havia organização nenhuma, e os testes passavam
 * sem exercitar uma linha do que prometiam testar.
 *
 * É a mesma família de defeito que `database.ts` documenta ter custado quatro
 * sprints ("seis specs ficaram verdes por ausência"), entrando por outra porta:
 * lá era banco ausente, aqui é banco presente e vazio. `REQUIRE_DATABASE` fecha
 * a primeira e não enxerga a segunda.
 *
 * ## Por que criar em vez de semear o banco do CI
 *
 * Um passo de seed no workflow tornaria todo spec dependente de um estado global
 * que ninguém declara no arquivo que o usa — e o primeiro teste a precisar de
 * algo a mais voltaria a `findFirst`. Um fixture que cria o que precisa deixa a
 * dependência visível onde ela é consumida.
 *
 * ## Idempotente por `upsert`
 *
 * Os specs rodam `--runInBand` contra o mesmo banco, e vários pedem o mesmo
 * inquilino. `upsert` deixa cada um pedir sem precisar saber quem veio antes.
 */
export type TenantFixture = {
  accountId: string;
  organizationId: string;
  integrationId: string;
  planId: string;
  organizationSubscriptionId: string;
  /**
   * A moeda-base da organização, que os specs de dinheiro precisam declarar.
   *
   * Vem do `upsert` e não de uma constante local: num banco já semeado a
   * organização pode ter outra, e um teste que assume `BRL` afirmaria conversão
   * onde não houve.
   */
  baseCurrency: string;
};

/** Um sufixo por spec mantém os inquilinos isolados e a limpeza previsível. */
export async function ensureTenant(
  prisma: PrismaService,
  suffix: string,
): Promise<TenantFixture> {
  const accountId = `${suffix}-tenant-account`;
  const organizationId = `${suffix}-tenant-org`;
  const integrationId = `${suffix}-tenant-integration`;

  const account = await prisma.account.upsert({
    where: { id: accountId },
    update: {},
    create: {
      id: accountId,
      name: 'Titular do fixture',
      email: `${suffix}-tenant@exemplo.test`,
      passwordHash: 'nao-usado-em-teste',
    },
  });

  const organization = await prisma.organization.upsert({
    where: { id: organizationId },
    update: {},
    create: {
      id: organizationId,
      name: `Organização de ${suffix}`,
      ownerId: account.id,
    },
    select: { id: true, baseCurrency: true },
  });

  const integration = await prisma.integration.upsert({
    where: { id: integrationId },
    update: {},
    create: {
      id: integrationId,
      accountId: account.id,
      organizationId: organization.id,
      provider: 'meta',
      providerType: 'META',
      accessToken: 'token-de-teste',
      // Longe o suficiente para nenhum teste esbarrar em expiração.
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  });

  const plan = await ensurePlan(prisma);

  /**
   * A assinatura **não é enfeite**: sem ela o inquilino não tem plano.
   *
   * `findPlanTypeByOrganizationId` devolve `null` para organização sem
   * assinatura vigente, e `planAllows` fecha na dúvida — então toda guarda de
   * feature recusa. Um fixture sem assinatura produz um tenant que nenhuma
   * organização real é, e testes de escrita em mídia paga falhariam por um
   * motivo que não é o deles.
   *
   * `ACTIVE` porque é o estado comum; `TRIALING` e `PAST_DUE` também concedem
   * plano, e escolher entre os três é decisão de quem testa cobrança.
   */
  const subscription = await prisma.organizationSubscription.upsert({
    where: { organizationId: organization.id },
    update: {},
    create: {
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      trialStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    organizationId: organization.id,
    integrationId: integration.id,
    planId: plan.id,
    organizationSubscriptionId: subscription.id,
    baseCurrency: organization.baseCurrency,
  };
}

/**
 * Um plano do catálogo, para as tabelas que têm FK para ele.
 *
 * **Chaveado por `type`, que é `@unique`.** O tipo é um enum de quatro valores,
 * então não há como inventar um descartável: ou se reusa o que o seed criaria,
 * ou se colide com ele. `upsert` por `type` faz as duas coisas darem no mesmo
 * resultado, e o `update` vazio garante que rodar o teste não reescreva o preço
 * de um plano real num banco que já foi semeado.
 */
async function ensurePlan(prisma: PrismaService): Promise<{ id: string }> {
  return prisma.plan.upsert({
    where: { type: 'ENTERPRISE' },
    update: {},
    create: {
      type: 'ENTERPRISE',
      name: 'Enterprise',
      amount: 1497,
    },
    select: { id: true },
  });
}

/** Remove o inquilino do sufixo. O plano fica: ele é catálogo, não fixture. */
export async function removeTenant(
  prisma: PrismaService,
  suffix: string,
): Promise<void> {
  await prisma.organizationSubscription.deleteMany({
    where: { organizationId: { startsWith: suffix } },
  });
  await prisma.integration.deleteMany({
    where: { id: { startsWith: suffix } },
  });
  await prisma.organization.deleteMany({
    where: { id: { startsWith: suffix } },
  });
  await prisma.account.deleteMany({ where: { id: { startsWith: suffix } } });
}
