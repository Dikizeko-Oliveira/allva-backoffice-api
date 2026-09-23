import { AnalysisQuotaService } from './analysis-quota.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';

/**
 * A cota mensal de análises de criativo — a parede que faltava, agora exata.
 *
 * O serviço é exercitado através do `PlanEntitlementService` **real**, com um
 * contador em memória que honra o contrato da porta. É o que faz o teste provar
 * a coisa certa: se a atomicidade só existisse no SQL, um dublê do serviço
 * inteiro passaria sem tocar nela.
 */
const CEILINGS: Record<PlanType, number> = {
  FREE: 3_000,
  STARTER: 300,
  PRO: 3_000,
  ENTERPRISE: 10_000,
};

/**
 * Um contador que se comporta como o Postgres: a decisão e o incremento
 * acontecem juntos, sem janela entre os dois.
 *
 * O `await` no meio é deliberado — é a janela em que o defeito original cabia.
 * Com a decisão antes dele, dois pedidos concorrentes passariam os dois.
 */
function inMemoryCounter(seed = 0) {
  const rows = new Map<string, number>();
  if (seed) rows.set('org-1|creative-analyses', seed);

  return {
    rows,
    reserve: jest.fn(
      async (input: {
        organizationId: string;
        feature: string;
        limit: number | null;
      }) => {
        const key = `${input.organizationId}|${input.feature}`;
        const current = rows.get(key) ?? 0;

        if (input.limit !== null && current >= input.limit) return null;

        const next = current + 1;
        rows.set(key, next);
        await Promise.resolve();

        return next;
      },
    ),
    release: jest.fn(
      async (input: { organizationId: string; feature: string }) => {
        const key = `${input.organizationId}|${input.feature}`;
        rows.set(key, Math.max((rows.get(key) ?? 0) - 1, 0));
        await Promise.resolve();
      },
    ),
    read: jest.fn(async (input: { organizationId: string; feature: string }) =>
      Promise.resolve(
        rows.get(`${input.organizationId}|${input.feature}`) ?? 0,
      ),
    ),
  };
}

function buildHarness({
  planType = 'STARTER' as PlanType,
  used = 0,
  negotiated = null as number | null,
}: { planType?: PlanType; used?: number; negotiated?: number | null } = {}) {
  const counters = inMemoryCounter(used);

  const plans = {
    findPlanTypeByOrganizationId: jest.fn().mockResolvedValue(planType),
    findContractedPlanTypeByOrganizationId: jest
      .fn()
      .mockResolvedValue(planType),
  };

  const quotas = {
    findOverrides: jest.fn().mockResolvedValue({
      adAccounts: null,
      monitoredAds: null,
      seats: null,
      organizations: null,
      copyGenerations: null,
      creativeAnalyses: negotiated,
      monthlyAnalyses: null,
    }),
  };

  const planEntitlement = new PlanEntitlementService(
    plans as never,
    quotas as never,
    counters as never,
  );

  return {
    service: new AnalysisQuotaService(planEntitlement),
    counters,
    ceiling: negotiated ?? CEILINGS[planType],
  };
}

const NOW = new Date('2026-09-08T12:00:00.000Z');

describe('AnalysisQuotaService', () => {
  it('libera enquanto o uso está abaixo do teto do plano', async () => {
    const { service } = buildHarness({ planType: 'STARTER', used: 298 });

    await expect(service.reserve('org-1', NOW)).resolves.toEqual({
      limit: 300,
      used: 299,
    });
  });

  /**
   * "Se o plano define 300, devem ser 300 — nem mais, nem menos."
   *
   * A 300ª passa e sai como `used: 300`; a 301ª cai. Um `>` no lugar do `>=`
   * deixaria a 301ª passar.
   */
  it('deixa passar a última do teto e recusa a seguinte', async () => {
    const { service } = buildHarness({ planType: 'STARTER', used: 299 });

    await expect(service.reserve('org-1', NOW)).resolves.toMatchObject({
      used: 300,
    });
    await expect(service.reserve('org-1', NOW)).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  /**
   * **O defeito que o contador existe para fechar.**
   *
   * Com `COUNT` e depois `INSERT`, dois pedidos disparados juntos com 99 de 100
   * liam 99 os dois e passavam os dois — o mês fechava em 101, e a tela de
   * assinatura mostrava "101 de 100". Aqui só um dos dois pode ganhar.
   */
  it('duas reservas simultâneas no limite: uma passa, a outra cai', async () => {
    const { service, counters } = buildHarness({
      planType: 'STARTER',
      used: 299,
    });

    const [primeiro, segundo] = await Promise.allSettled([
      service.reserve('org-1', NOW),
      service.reserve('org-1', NOW),
    ]);

    const desfechos = [primeiro.status, segundo.status].sort();
    expect(desfechos).toEqual(['fulfilled', 'rejected']);

    // E o contador para exatamente no teto — nunca 101.
    expect(counters.rows.get('org-1|creative-analyses')).toBe(300);
  });

  it('o consumo exibido nunca ultrapassa o teto', async () => {
    const { service } = buildHarness({ planType: 'STARTER', used: 299 });

    await service.reserve('org-1', NOW);
    await service.reserve('org-1', NOW).catch(() => undefined);

    const { used, limit } = await service.usage('org-1', NOW);

    expect(used).toBe(300);
    expect(limit).toBe(300);
    expect(used).toBeLessThanOrEqual(limit!);
  });

  it('devolve a reserva quando o trabalho não acontece', async () => {
    // O preço de a cota ser exata: a unidade sai antes do trabalho, e uma falha
    // que não produziu nada não pode ser cobrada.
    const { service, counters } = buildHarness({
      planType: 'STARTER',
      used: 50,
    });

    await service.reserve('org-1', NOW);
    expect(counters.rows.get('org-1|creative-analyses')).toBe(51);

    await service.release('org-1', NOW);
    expect(counters.rows.get('org-1|creative-analyses')).toBe(50);
  });

  it('recusa com PLAN_LIMITED, e não como limite de taxa', async () => {
    // O teto diário de IA reabre amanhã sozinho e é `RATE_LIMITED`; a cota do
    // mês só se resolve esperando a virada ou mudando de plano.
    const { service } = buildHarness({ planType: 'STARTER', used: 300 });

    await expect(service.reserve('org-1', NOW)).rejects.toMatchObject({
      code: 'CREATIVE_ANALYSIS_QUOTA_EXCEEDED',
      category: 'PLAN_LIMITED',
    });
  });

  it('diz quando a cota volta e para onde subir', async () => {
    const { service } = buildHarness({ planType: 'STARTER', used: 300 });

    await service.reserve('org-1', NOW).catch((error: DomainError) => {
      expect(error.details).toMatchObject({
        used: 300,
        limit: 300,
        resetsAt: '2026-10-01T00:00:00.000Z',
        upgradeTo: 'Profissional',
      });
    });

    expect.assertions(1);
  });

  /**
   * O contrato Enterprise vence o piso publicado. Sem isto, o cliente que
   * negociou 12.000 continuaria sendo cortado em 2.000 — e o "sob medida" da
   * página de preços seria texto sem efeito.
   */
  it('respeita o teto negociado em contrato acima do piso do plano', async () => {
    const { service } = buildHarness({
      planType: 'ENTERPRISE',
      used: 2_500,
      negotiated: 12_000,
    });

    await expect(service.reserve('org-1', NOW)).resolves.toMatchObject({
      limit: 12_000,
      used: 2_501,
    });
  });

  it('reserva na janela do mês corrente, em UTC', async () => {
    const { service, counters } = buildHarness();

    await service.reserve('org-1', NOW);

    expect(counters.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
      }),
    );
  });

  it('informa sem consumir quando só se quer exibir o contador', async () => {
    // O caminho do reuso de P9: não produz nada, não cobra nada.
    const { service, counters } = buildHarness({
      planType: 'STARTER',
      used: 42,
    });

    await expect(service.usage('org-1', NOW)).resolves.toEqual({
      limit: 300,
      used: 42,
    });
    expect(counters.reserve).not.toHaveBeenCalled();
  });
});
