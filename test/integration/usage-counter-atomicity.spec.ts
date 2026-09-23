import { requireDatabaseWhenExpected } from '../support/database';
import { PrismaService } from '../../src/shared/infrastructure/database/prisma/prisma.service';
import { ensureTenant, removeTenant } from '../support/tenant-fixture';
import { UsageCounterPrismaRepository } from '../../src/modules/organizations/infrastructure/database/prisma/usage-counter-prisma.repository';

/**
 * **A cota mensal sob pedidos simultâneos** — o fim do "101 de 100".
 *
 * As duas cotas do Creative Lab liam `COUNT(*)` e depois inseriam. Entre as duas
 * operações não havia trava: dois cliques na mesma janela liam 99 os dois,
 * passavam os dois pelo `99 < 100`, e o mês fechava em 101 — com a tela de
 * assinatura exibindo o furo em letras grandes para o cliente.
 *
 * A correção é `INSERT … ON CONFLICT DO UPDATE … WHERE used < limite`, e o
 * `WHERE` é avaliado **depois** de o Postgres travar a linha em conflito. Isso é
 * uma afirmação sobre o banco, não sobre o TypeScript: um dublê em memória prova
 * que o serviço chama a porta certa, e não que a instrução é atômica. Por isso o
 * teste vive aqui, disparando N reservas em paralelo de verdade.
 */
const SUFFIX = 'usage-counter-spec';
const FEATURE = 'creative-analyses-spec';
const PERIOD = new Date('2026-09-01T00:00:00.000Z');

let prisma: PrismaService | null = null;
let reason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('usage-counter-atomicity');

  if (probe.reachable) prisma = new PrismaService();
  else reason = probe.reason;
}, 20_000);

afterAll(async () => {
  if (!prisma) return;
  await cleanup(prisma);
  await prisma.$disconnect();
});

async function cleanup(client: PrismaService): Promise<void> {
  await client.organizationUsageCounter.deleteMany({
    where: { feature: FEATURE },
  });
  await removeTenant(client, SUFFIX);
}

/**
 * Uma organização real, porque a chave estrangeira exige uma.
 *
 * `feature` é um slug de teste (`…-spec`), então nada aqui colide com a cota de
 * produção da mesma organização.
 */
async function seed(client: PrismaService): Promise<string> {
  await cleanup(client);

  /**
   * Cria o inquilino, em vez de procurar um: no banco vazio do CI não havia
   * organização, e o teste de atomicidade passava sem disparar uma reserva.
   */
  return (await ensureTenant(client, SUFFIX)).organizationId;
}

describe('contador de cota — atomicidade', () => {
  it('vinte reservas simultâneas com teto de dez param exatamente em dez', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    const organizationId = await seed(prisma);
    if (!organizationId) {
      return expect('sem organização para o fixture').toBeTruthy();
    }

    const counters = new UsageCounterPrismaRepository(prisma);

    /**
     * Vinte de uma vez, sem `await` entre elas: é a única forma de o teste
     * exercer a corrida. Sequencialmente, qualquer implementação passa.
     */
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        counters.reserve({
          organizationId,
          feature: FEATURE,
          periodStart: PERIOD,
          limit: 10,
        }),
      ),
    );

    const granted = outcomes.filter((used) => used !== null);
    const refused = outcomes.filter((used) => used === null);

    expect(granted).toHaveLength(10);
    expect(refused).toHaveLength(10);

    /**
     * **Nenhuma reserva repete o número.** É a afirmação mais forte do teste:
     * dois pedidos devolvendo `7` significaria que os dois leram o mesmo estado,
     * que é exatamente o defeito — mesmo que o total final coincidisse.
     */
    expect(new Set(granted).size).toBe(10);
    expect([...granted].sort((a, b) => Number(a) - Number(b))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    await expect(
      counters.read({ organizationId, feature: FEATURE, periodStart: PERIOD }),
    ).resolves.toBe(10);
  }, 30_000);

  it('a devolução não deixa o contador negativo', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    const organizationId = await seed(prisma);
    if (!organizationId) {
      return expect('sem organização para o fixture').toBeTruthy();
    }

    const counters = new UsageCounterPrismaRepository(prisma);
    const key = { organizationId, feature: FEATURE, periodStart: PERIOD };

    await counters.reserve({ ...key, limit: 10 });

    // Três devoluções para uma reserva: um chamador com bug. O contador absorve
    // em vez de ficar negativo — um negativo tornaria a cota infinita até
    // alguém notar, que é a pior falha possível numa guarda de cobrança.
    await counters.release(key);
    await counters.release(key);
    await counters.release(key);

    await expect(counters.read(key)).resolves.toBe(0);
  }, 30_000);

  it('teto zero não concede a primeira, nem cria linha', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    const organizationId = await seed(prisma);
    if (!organizationId) {
      return expect('sem organização para o fixture').toBeTruthy();
    }

    const counters = new UsageCounterPrismaRepository(prisma);
    const key = { organizationId, feature: FEATURE, periodStart: PERIOD };

    /**
     * O caso que o `ON CONFLICT` sozinho erraria: sem linha no período, o ramo
     * de inserção não avalia o `WHERE` e `used` nasceria 1 mesmo com teto 0.
     * Plano irresolúvel tem teto 0 (`planQuota` fecha na dúvida), então isto é
     * real, não teórico.
     */
    await expect(counters.reserve({ ...key, limit: 0 })).resolves.toBeNull();
    await expect(counters.read(key)).resolves.toBe(0);
  }, 30_000);

  it('sem teto, conta e nunca recusa', async () => {
    if (!prisma) return expect(reason).toBeTruthy();

    const organizationId = await seed(prisma);
    if (!organizationId) {
      return expect('sem organização para o fixture').toBeTruthy();
    }

    const counters = new UsageCounterPrismaRepository(prisma);
    const key = { organizationId, feature: FEATURE, periodStart: PERIOD };

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        counters.reserve({ ...key, limit: null }),
      ),
    );

    expect(outcomes.every((used) => used !== null)).toBe(true);
    await expect(counters.read(key)).resolves.toBe(5);
  }, 30_000);
});
