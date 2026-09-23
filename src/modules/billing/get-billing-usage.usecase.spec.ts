import {
  effectiveQuota,
  type QuotaFeatureKey,
} from 'src/modules/plans/domain/plan-entitlements';
import { GetBillingUsageUseCase } from './get-billing-usage.usecase';
import {
  UsageSnapshotService,
  type UsageDimension,
} from './usage-snapshot.service';

function buildHarness({
  planType = 'PRO',
  organizationId = null,
  creativeAnalyses = 0,
  copyGenerations = 0,
  monitoredAds = 0,
  adsExcluded = 0,
  rotationQueue = 0,
  negotiated = null,
}: {
  planType?: string | null;
  organizationId?: string | null;
  creativeAnalyses?: number;
  copyGenerations?: number;
  monitoredAds?: number;
  adsExcluded?: number;
  rotationQueue?: number;
  /** O teto negociado em contrato, quando houver — por feature. */
  negotiated?: Record<string, number> | null;
} = {}) {
  const subscriptionsRepository = {
    findByAccountId: jest
      .fn()
      .mockResolvedValue(planType ? { plan: { type: planType } } : null),
  };

  const scope = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ accountId: 'account-1', organizationId }),
  };

  /**
   * A régua de anúncios vem de quem escreve `analysisEligibleAt` — o medidor
   * não reimplementa o predicado, e o dublê reflete isso.
   */
  const analysisScope = {
    countEligible: jest.fn().mockResolvedValue(monitoredAds),
    countExcluded: jest.fn().mockResolvedValue(adsExcluded),
    countRotationQueue: jest.fn().mockResolvedValue(rotationQueue),
  };

  /**
   * O dublê responde como o serviço real: o negociado vence o do plano, e sem
   * negociado o teto sai do catálogo. Resolver pelo catálogo de verdade é o que
   * faz o teste falhar se alguém mexer nos números do packaging sem olhar aqui.
   */
  const planEntitlement = {
    quotaFor: jest.fn(({ feature }: { feature: QuotaFeatureKey }) =>
      Promise.resolve(
        effectiveQuota(
          planType as never,
          feature,
          negotiated?.[feature] ?? null,
        ),
      ),
    ),
    /**
     * As duas cotas mensais vêm do **contador de reservas**, não das tabelas.
     * É o mesmo número contra o qual a guarda julga o próximo pedido, e é por
     * isso que a tela não pode discordar dela.
     */
    consumedIn: jest.fn(({ feature }: { feature: QuotaFeatureKey }) =>
      Promise.resolve(
        feature === 'creative-analyses'
          ? creativeAnalyses
          : feature === 'copy-generation'
            ? copyGenerations
            : 0,
      ),
    ),
  };

  const useCase = new GetBillingUsageUseCase(
    subscriptionsRepository as never,
    scope as never,
    // O snapshot real, com prisma e planos dublados: o que se testa aqui é o
    // que o medidor conta e contra qual teto, e um dublê do snapshot inteiro
    // testaria só a fiação.
    new UsageSnapshotService(planEntitlement as never, analysisScope as never),
  );

  return {
    useCase,
    subscriptionsRepository,
    scope,
    planEntitlement,
    analysisScope,
  };
}

/** A dimensão pelo nome, para os testes não dependerem da ordem do array. */
function dimension(usage: { dimensions: UsageDimension[] }, key: string) {
  const found = usage.dimensions.find((entry) => entry.key === key);
  if (!found) throw new Error(`dimensão ausente: ${key}`);

  return found;
}

describe('GetBillingUsageUseCase', () => {
  /**
   * O defeito relatado: gerar análises de criativo e variações de copy e abrir
   * a tela de assinatura para encontrar tudo zerado. As duas cotas existiam —
   * uma delas já recusava no teto — e nenhuma chegava aqui.
   */
  it('mede as duas cotas do Creative Lab', async () => {
    const { useCase } = buildHarness({
      organizationId: 'org-9',
      creativeAnalyses: 7,
      copyGenerations: 4,
    });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'creative-analyses')).toMatchObject({
      used: 7,
      limit: 3_000,
      enforced: true,
    });
    expect(dimension(usage, 'copy-generation')).toMatchObject({
      used: 4,
      limit: 100,
      enforced: true,
    });
  });

  /**
   * **Toda linha da tela recusa alguma coisa.**
   *
   * O contador de achados da madrugada saiu daqui: era resultado do produto e
   * não consumo do plano, e nada o aplicava. Uma barra que não corta ensina o
   * usuário a esperar um bloqueio que nunca vem, e gasta a confiança das que
   * cortam de verdade.
   */
  it('não reporta dimensão que não recusa nada', async () => {
    const { useCase } = buildHarness({ organizationId: 'org-9' });

    const usage = await useCase.execute('account-1');

    expect(usage.dimensions.map((entry) => entry.key)).toEqual([
      'monitored-ads',
      'creative-analyses',
      'copy-generation',
    ]);
    expect(usage.dimensions.every((entry) => entry.enforced)).toBe(true);
  });

  /**
   * A tela lê o **mesmo contador** que a guarda julga.
   *
   * Contar `copy_generations` aqui daria um número parecido e nunca idêntico —
   * o contador registra autorização concedida, e é contra ele que a próxima
   * chamada será recusada. Duas fontes divergem, e a que erra é a que ninguém
   * revisita.
   */
  it('lê as duas cotas do contador de reservas, não das tabelas', async () => {
    const { useCase, planEntitlement } = buildHarness({
      organizationId: 'org-9',
      creativeAnalyses: 7,
      copyGenerations: 4,
    });

    await useCase.execute('account-1');

    expect(planEntitlement.consumedIn).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'creative-analyses' }),
    );
    expect(planEntitlement.consumedIn).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'copy-generation' }),
    );
  });

  /**
   * O teto de anúncios é a parede mais cara do plano, e era a única que não
   * aparecia aqui. "300 de 300" sozinho lê como folga; com os 600 de fora, lê
   * como a fila que é.
   */
  it('mostra os anúncios analisados e quantos ficaram fora do teto', async () => {
    const { useCase } = buildHarness({
      // Individual: 300 é o teto publicado, e é o caso em que a fila aparece.
      planType: 'STARTER',
      organizationId: 'org-9',
      monitoredAds: 300,
      adsExcluded: 600,
      rotationQueue: 600,
    });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'monitored-ads')).toMatchObject({
      used: 300,
      limit: 300,
      excluded: 600,
      enforced: true,
      // Capacidade, não consumo: a régua é refeita toda noite e nada acumula.
      resetsAt: null,
      // 600 esperando, 60 vagas por noite (300 × 20%) → 10 noites.
      rotationCycleNights: 10,
    });
  });

  /**
   * **A fila viva, não a cauda inteira.**
   *
   * `countExcluded` inclui anúncio pausado e sem entrega, que o rodízio nunca
   * chama. Usá-lo como denominador prometeria uma espera que não existe — aqui,
   * 5.000 fora do escopo mas só 600 vivos: 10 noites, não 84.
   */
  it('calcula o ciclo sobre a fila viva, não sobre a cauda morta', async () => {
    const { useCase } = buildHarness({
      planType: 'STARTER',
      organizationId: 'org-9',
      monitoredAds: 300,
      adsExcluded: 5_000,
      rotationQueue: 600,
    });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'monitored-ads').rotationCycleNights).toBe(10);
  });

  it('sem fila não há ciclo a descrever', async () => {
    const { useCase } = buildHarness({
      planType: 'STARTER',
      organizationId: 'org-9',
      monitoredAds: 120,
      rotationQueue: 0,
    });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'monitored-ads').rotationCycleNights).toBeNull();
  });

  it('distingue a linha medida das linhas que recusam', async () => {
    // A tela precisa da diferença: barra cheia que bloqueia pede upgrade, barra
    // cheia que só informa pede silêncio.
    const { useCase } = buildHarness({ organizationId: 'org-9' });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'creative-analyses').enforced).toBe(true);
    expect(dimension(usage, 'copy-generation').enforced).toBe(true);
  });

  /**
   * O `9999` fixo do Enterprise era o defeito mais silencioso dos dois: a tela
   * que o cliente abre para conferir o contrato mostrava um número que o
   * contrato não diz.
   */
  it('mostra o teto negociado em contrato, e não o piso publicado', async () => {
    const { useCase } = buildHarness({
      planType: 'ENTERPRISE',
      organizationId: 'org-9',
      negotiated: { 'creative-analyses': 12_000 },
    });

    const usage = await useCase.execute('account-1');

    expect(dimension(usage, 'creative-analyses').limit).toBe(12_000);
    // Sem override, o Enterprise cai no piso do catálogo — nunca em 9999.
    expect(dimension(usage, 'copy-generation').limit).toBe(300);
  });

  it('não consulta contador nem régua quando o escopo é de conta', async () => {
    // Sem organização não há contador, não há contrato e não há régua de
    // anúncios: perguntar devolveria o dado de outro tenant ou nenhum.
    const { useCase, planEntitlement, analysisScope } = buildHarness({
      organizationId: null,
      creativeAnalyses: 7,
    });

    const usage = await useCase.execute('account-1');

    expect(planEntitlement.consumedIn).not.toHaveBeenCalled();
    expect(analysisScope.countEligible).not.toHaveBeenCalled();
    expect(dimension(usage, 'creative-analyses').used).toBe(0);
  });

  it('carimba quando cada contador zera', async () => {
    const { useCase } = buildHarness({ organizationId: 'org-9' });

    const usage = await useCase.execute(
      'account-1',
      new Date('2026-07-15T12:00:00.000Z'),
    );

    // As cotas do Creative Lab viram em UTC, como as guardas delas contam.
    expect(dimension(usage, 'creative-analyses').resetsAt).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });
});
