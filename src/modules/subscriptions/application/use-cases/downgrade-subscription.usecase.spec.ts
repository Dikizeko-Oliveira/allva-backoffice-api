import { DowngradeSubscriptionUseCase } from './downgrade-subscription.usecase';

const PRO = {
  id: 'plan-pro',
  type: 'PRO',
  name: 'Pro',
  amount: 497,
};

const STARTER = {
  id: 'plan-starter',
  type: 'STARTER',
  name: 'Individual',
  amount: 147,
};

const ENTERPRISE = {
  id: 'plan-enterprise',
  type: 'ENTERPRISE',
  name: 'Enterprise',
  amount: 1497,
};

const BY_TYPE: Record<string, unknown> = {
  PRO,
  STARTER,
  ENTERPRISE,
};

function buildHarness({ current = PRO }: { current?: unknown } = {}) {
  const plansRepository = {
    findByType: jest.fn((type: string) =>
      Promise.resolve(BY_TYPE[type] ?? null),
    ),
    findById: jest.fn().mockResolvedValue(current),
  };

  const subscriptionsRepository = {
    findByAccountId: jest.fn().mockResolvedValue({
      id: 'sub-1',
      planId: (current as { id: string }).id,
      plan: current,
      updatePlan: jest.fn(),
    }),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const useCase = new DowngradeSubscriptionUseCase(
    plansRepository as never,
    subscriptionsRepository as never,
  );

  return { useCase, plansRepository, subscriptionsRepository };
}

/**
 * A rota depreciada `POST /subscriptions/downgrade`.
 *
 * Ela é a quarta porta para a mesma cobrança indevida, e era a mais silenciosa:
 * `DowngradePlanType` aceita `ENTERPRISE`, e o que impedia a assinatura de ir
 * parar lá era só `INVALID_DOWNGRADE_TARGET` — o Enterprise é o mais caro, logo
 * nenhum downgrade chega nele. Isso é coincidência de tabela de preços, não
 * regra: um plano acima dele reabre a porta sem ninguém ter decidido reabrir.
 */
describe('DowngradeSubscriptionUseCase', () => {
  it('recusa o Enterprise pelo packaging, não pela aritmética', async () => {
    const h = buildHarness();

    await expect(
      h.useCase.execute('acc-1', { planType: 'ENTERPRISE' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PLAN_REQUIRES_SALES_CONTACT' },
    });

    // A recusa acontece antes de olhar a assinatura vigente — é decisão de
    // catálogo, e não depende de quanto o plano atual custa.
    expect(h.subscriptionsRepository.findByAccountId).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });

  it('continua recusando o FREE por esta rota', async () => {
    const h = buildHarness();

    await expect(
      h.useCase.execute('acc-1', { planType: 'FREE' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PLAN_NOT_FOUND' },
    });
  });

  it('deixa passar um downgrade legítimo entre planos de autoatendimento', async () => {
    const h = buildHarness();

    await expect(
      h.useCase.execute('acc-1', { planType: 'STARTER' } as never),
    ).resolves.toBeDefined();

    expect(h.subscriptionsRepository.update).toHaveBeenCalled();
  });
});
