import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { EnterpriseContractsPrismaRepository } from '../../src/modules/contracts/infrastructure/database/prisma/enterprise-contracts-prisma.repository';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';

/**
 * **Contratos vivos sem teto diário de gasto com IA.**
 *
 * `llm_daily_budget_base` nulo significa "permite" para `evaluateBudget`. Num
 * contrato ainda não precificado isso é escolha legítima — o default de
 * R$ 50/dia foi calibrado para o maior plano de autoatendimento e cortaria uma
 * entrega de 40.000 anúncios na primeira madrugada. O que não pode é ser escolha
 * por omissão.
 *
 * Vive aqui porque a consulta é SQL cru, e o caso que mais importa é justamente
 * o que um `JOIN` interno esconderia: a organização **sem linha** de
 * configuração, que é a mais grave — nem o default chegou nela.
 */
const SUFFIX = 'sem-teto-ia-spec';

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected(
    'contracts-without-ai-budget',
  );

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.enterpriseContract.deleteMany({
    where: { id: { startsWith: SUFFIX } },
  });
  await client.salesLead.deleteMany({ where: { id: { startsWith: SUFFIX } } });
  await client.organizationAdsSettings.deleteMany({
    where: { organizationId: { startsWith: SUFFIX } },
  });
  await client.organizationQuota.deleteMany({
    where: { organizationId: { startsWith: SUFFIX } },
  });
  await removeTenant(client, SUFFIX);
}

type Caso = {
  chave: string;
  /** `undefined` não cria a linha de configuração — a organização órfã. */
  teto?: number | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'SIGNED';
  monitoredAds?: number;
};

async function seed(client: PrismaService, casos: Caso[]): Promise<string> {
  await cleanup(client);

  /**
   * Cria o que precisa, em vez de procurar.
   *
   * A primeira versão fazia `plan.findFirst` e lançava se não achasse — o que
   * quebrou no CI, que roda `migrate deploy` num banco vazio e nada mais. O
   * erro foi barulhento e por isso barato; o mesmo desenho com `findFirst` +
   * degradação teria passado sem testar nada.
   */
  const tenant = await ensureTenant(client, SUFFIX);
  const owner = { id: tenant.accountId };
  const plan = { id: tenant.planId };

  for (const caso of casos) {
    const organizationId = `${SUFFIX}-${caso.chave}`;

    await client.organization.create({
      data: {
        id: organizationId,
        name: `Organização ${caso.chave}`,
        ownerId: owner.id,
      },
    });

    // `teto` ausente = organização sem linha de configuração nenhuma.
    if (caso.teto !== undefined) {
      await client.organizationAdsSettings.create({
        data: { organizationId, llmDailyBudgetBase: caso.teto },
      });
    }

    if (caso.monitoredAds !== undefined) {
      await client.organizationQuota.create({
        data: { organizationId, maxMonitoredAds: caso.monitoredAds },
      });
    }

    const lead = await client.salesLead.create({
      data: {
        id: `${SUFFIX}-lead-${caso.chave}`,
        companyName: `Empresa ${caso.chave}`,
        workEmail: `${caso.chave}@exemplo.com`,
        fullName: 'Contato',
        desiredPlan: 'ENTERPRISE',
      },
    });

    await client.enterpriseContract.create({
      data: {
        id: `${SUFFIX}-${caso.chave}`,
        contractNumber: `CT-${SUFFIX}-${caso.chave}`,
        salesLeadId: lead.id,
        organizationId,
        planId: plan.id,
        status: caso.status,
        startsAt: new Date('2026-01-01'),
        endsAt: new Date('2027-01-01'),
        billingInterval: 'MONTHLY',
        billingAmount: 5_000,
        paymentTerms: 'NET_30',
        paymentMethod: 'BOLETO',
        signedAt: new Date('2026-01-01'),
        activatedAt: caso.status === 'SIGNED' ? null : new Date('2026-01-02'),
      },
    });
  }

  return owner.id;
}

async function chaves(client: PrismaService): Promise<string[]> {
  const repo = new EnterpriseContractsPrismaRepository(client);
  const rows = await repo.listWithoutAiBudget();

  return rows
    .filter((row) => row.contractId.startsWith(SUFFIX))
    .map((row) => row.contractId.replace(`${SUFFIX}-`, ''))
    .sort();
}

describe('contratos sem teto de IA', () => {
  it('lista quem tem a coluna nula e quem não tem linha nenhuma', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    await seed(prisma, [
      { chave: 'nulo', teto: null, status: 'ACTIVE' },
      // Sem linha de configuração: o caso mais grave, e o que um `JOIN` interno
      // esconderia — nem o default do schema chegou nela.
      { chave: 'orfa', status: 'ACTIVE' },
      { chave: 'precificado', teto: 400, status: 'ACTIVE' },
    ]);

    await expect(chaves(prisma)).resolves.toEqual(['nulo', 'orfa']);
  }, 60_000);

  it('suspenso entra: ele volta, e volta consumindo', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    await seed(prisma, [
      { chave: 'suspenso', teto: null, status: 'SUSPENDED' },
    ]);

    await expect(chaves(prisma)).resolves.toEqual(['suspenso']);
  }, 60_000);

  it('contrato não ativado fica de fora', async () => {
    // Antes da ativação não há organização provisionada de verdade, e cobrar um
    // teto de quem não tem onde gastá-lo encheria a lista de linhas sem ação.
    if (!prisma) return expect(reason).toBeTruthy();

    await seed(prisma, [{ chave: 'assinado', teto: null, status: 'SIGNED' }]);

    await expect(chaves(prisma)).resolves.toEqual([]);
  }, 60_000);

  it('traz a escala contratada, que é o que dimensiona o teto', async () => {
    // 300 anúncios e 40.000 pedem tetos de ordens diferentes; sem o número o
    // operador teria de abrir cada contrato para saber qual é qual.
    if (!prisma) return expect(reason).toBeTruthy();

    await seed(prisma, [
      { chave: 'grande', teto: null, status: 'ACTIVE', monitoredAds: 40_000 },
    ]);

    const repo = new EnterpriseContractsPrismaRepository(prisma);
    const row = (await repo.listWithoutAiBudget()).find((entry) =>
      entry.contractId.startsWith(SUFFIX),
    );

    expect(row).toMatchObject({
      maxMonitoredAds: 40_000,
      organizationName: 'Organização grande',
      status: 'ACTIVE',
    });
  }, 60_000);
});
