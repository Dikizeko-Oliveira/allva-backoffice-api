import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { ListAvailableActionsUseCase } from './list-available-actions.usecase';

const gateway = {
  platform: 'META',
  capabilities: () => [
    {
      type: 'PAUSE_AD',
      supported: true,
      reversible: true,
      requiresRecreate: false,
      createsEntity: false,
      validationDepth: 'LOCAL_ONLY',
    },
    {
      type: 'PAUSE_AD_SET',
      supported: true,
      reversible: true,
      requiresRecreate: false,
      createsEntity: false,
      validationDepth: 'LOCAL_ONLY',
    },
  ],
} as never;

function buildUseCase(
  planType: string,
  integrationId: string | null = 'int-1',
) {
  const targets = {
    findTarget: jest.fn().mockResolvedValue({
      adId: 'ad-1',
      platform: 'META',
      unitKind: 'AD',
      observedStatus: 'ACTIVE',
      syncState: 'IN_SYNC',
      actionsEnabled: true,
      integrationId,
      adSet: { id: 'set-1' },
      campaign: { id: 'camp-1' },
    }),
    findInFlightWrites: jest.fn().mockResolvedValue([]),
  };

  const organizationPlan = {
    findPlanTypeByOrganizationId: jest.fn().mockResolvedValue(planType),
  };

  const env = {
    get: (key: string) =>
      ({
        PLATFORM_ACTIONS_ENABLED: true,
        PLATFORM_ACTIONS_DRY_RUN_ONLY: false,
      })[key],
  } as unknown as EnvService;

  const useCase = new ListAvailableActionsUseCase(
    targets as never,
    new ActionCapabilityRegistryService([gateway]),
    new PlanEntitlementService(
      organizationPlan as never,
      {
        findOverrides: jest.fn().mockResolvedValue({
          adAccounts: null,
          monitoredAds: null,
          seats: null,
        }),
      } as never,
      /**
       * Guarda liga/desliga não reserva cota — e o dublê que lança é o que
       * prova isso. Um que devolvesse número esconderia uma reserva indevida.
       */
      {
        reserve: jest.fn(() => {
          throw new Error('guarda liga/desliga não deve reservar cota');
        }),
        release: jest.fn(),
        read: jest.fn().mockResolvedValue(0),
      } as never,
    ),
    env,
  );

  return { useCase, organizationPlan };
}

async function actionsFor(planType: string) {
  const { useCase } = buildUseCase(planType);
  const response = await useCase.execute({
    organizationId: 'org-1',
    adId: 'ad-1',
  });

  const actions = (
    response.data as {
      actions: Array<{
        type: string;
        available: boolean;
        executable: boolean;
        reason?: string;
        detail?: string;
      }>;
    }
  ).actions;

  return {
    ad: actions.find((a) => a.type === 'PAUSE_AD')!,
    adSet: actions.find((a) => a.type === 'PAUSE_AD_SET')!,
  };
}

describe('a tela nunca oferece um botão que só pode dar 403', () => {
  it('marca a ação fora do plano como indisponível, com o motivo', async () => {
    const { adSet } = await actionsFor('STARTER');

    expect(adSet.available).toBe(false);
    expect(adSet.executable).toBe(false);
    expect(adSet.reason).toBe('PLAN_LIMITED');
    expect(adSet.detail).toContain('plano');
  });

  it('declara a ação em vez de omiti-la — é assim que o upgrade fica visível', async () => {
    // Sumir com a linha faria o usuário nunca descobrir o que está deixando de
    // comprar. É a mesma razão pela qual `UNSUPPORTED_BY_PLATFORM` é declarada.
    const { adSet } = await actionsFor('STARTER');

    expect(adSet).toBeDefined();
    expect(adSet.type).toBe('PAUSE_AD_SET');
  });

  it('não toca no que o plano inclui', async () => {
    const { ad } = await actionsFor('STARTER');

    expect(ad.available).toBe(true);
    expect(ad.executable).toBe(true);
    expect(ad.reason).toBeUndefined();
  });

  it('o Profissional vê as duas disponíveis', async () => {
    const { ad, adSet } = await actionsFor('PRO');

    expect(ad.available).toBe(true);
    expect(adSet.available).toBe(true);
    expect(adSet.reason).toBeUndefined();
  });

  it('resolve o plano uma vez por chave aplicável, não uma por ação', async () => {
    // Treze ações e duas chaves: consultar por ação faria treze idas ao banco
    // para responder duas perguntas.
    const { useCase, organizationPlan } = buildUseCase('PRO');

    await useCase.execute({ organizationId: 'org-1', adId: 'ad-1' });

    expect(
      organizationPlan.findPlanTypeByOrganizationId.mock.calls.length,
    ).toBeLessThanOrEqual(3);
  });
});

describe('conta desconectada é um portão, não um 404 (P10)', () => {
  async function gatesFor(integrationId: string | null) {
    const { useCase } = buildUseCase('PRO', integrationId);
    const response = await useCase.execute({
      organizationId: 'org-1',
      adId: 'ad-1',
    });

    return response.data as {
      writeGates: { accountConnected: boolean };
      actions: Array<{ type: string; available: boolean; executable: boolean }>;
    };
  }

  it('a rota responde — o anúncio existe, e é só a credencial que falta', async () => {
    // Antes o repositório descartava o alvo inteiro e a rota devolvia
    // `404 Anúncio não encontrado` sobre um anúncio que aparece em todas as
    // outras telas. A tela não tinha como distinguir "sumiu" de "reconecte".
    const data = await gatesFor(null);

    expect(data.writeGates.accountConnected).toBe(false);
    expect(data.actions).toHaveLength(2);
  });

  it('nada é executável sem credencial, mas tudo continua declarado', async () => {
    const data = await gatesFor(null);

    expect(data.actions.every((action) => action.executable)).toBe(false);
    // `available` é sobre o anúncio e a plataforma; o portão é outra coisa, e
    // achatá-los faria "a Meta não faz isso" e "falta credencial" virarem um.
    expect(data.actions.find((a) => a.type === 'PAUSE_AD')!.available).toBe(
      true,
    );
  });

  it('com credencial o portão sai da frente', async () => {
    const data = await gatesFor('int-1');

    expect(data.writeGates.accountConnected).toBe(true);
    expect(data.actions.find((a) => a.type === 'PAUSE_AD')!.executable).toBe(
      true,
    );
  });
});
