import { resolveNextStep } from 'src/modules/organizations/domain/onboarding';
import { OnboardingStateService } from './onboarding-state.service';

/**
 * O passo que a tela obedece.
 *
 * A regra que estes testes prendem é a **ordem**, porque ela é a única parte
 * não óbvia: cada passo é pré-requisito técnico do seguinte, não preferência de
 * produto. Trocar dois de lugar produz uma tela que manda o usuário para um 403
 * ou para uma mensagem de erro onde havia só espera.
 */

const COMPLETE = {
  hasOrganization: true,
  hasActiveSubscription: true,
  hasConnectedIntegration: true,
  hasLinkedAdAccount: true,
  hasSyncedAds: true,
};

describe('o próximo passo do onboarding', () => {
  it('tudo pronto é READY', () => {
    expect(resolveNextStep(COMPLETE)).toBe('READY');
  });

  it('sem organização, o passo é criá-la — antes de qualquer outro', () => {
    // `integrations.organization_id` e `ads.organization_id` são NOT NULL: sem
    // organização o resto não tem onde existir.
    expect(
      resolveNextStep({
        hasOrganization: false,
        hasActiveSubscription: false,
        hasConnectedIntegration: false,
        hasLinkedAdAccount: false,
        hasSyncedAds: false,
      }),
    ).toBe('CREATE_ORGANIZATION');
  });

  it('assinatura vem antes de plataforma', () => {
    /**
     * `POST /integrations` está atrás de `EntitlementGuard` com
     * `@RequireAccessStatuses('ALLOWED','GRACE_PERIOD')`. Inverter a ordem
     * mandaria para Integrações quem só pode receber 403 de lá.
     */
    expect(resolveNextStep({ ...COMPLETE, hasActiveSubscription: false })).toBe(
      'SUBSCRIBE',
    );
  });

  it('sem credencial conectada, o passo é conectar', () => {
    expect(
      resolveNextStep({
        ...COMPLETE,
        hasConnectedIntegration: false,
        hasLinkedAdAccount: false,
        hasSyncedAds: false,
      }),
    ).toBe('CONNECT_PLATFORM');
  });

  it('conectado mas sem conta vinculada, o passo é vincular', () => {
    expect(
      resolveNextStep({
        ...COMPLETE,
        hasLinkedAdAccount: false,
        hasSyncedAds: false,
      }),
    ).toBe('LINK_AD_ACCOUNT');
  });

  it('vinculado e sem anúncio é espera, não erro', () => {
    /**
     * O estado que evita a mentira mais provável da dashboard: quem conectou o
     * Meta e vinculou a conta fez tudo certo e mesmo assim não tem anúncio até
     * a primeira ingestão rodar. Sem este passo, a tela vazia mandaria de volta
     * para Integrações — sugerindo erro onde há só espera.
     */
    expect(resolveNextStep({ ...COMPLETE, hasSyncedAds: false })).toBe(
      'AWAITING_FIRST_SYNC',
    );
  });
});

function buildHarness(
  options: {
    signals?: Partial<{
      hasConnectedIntegration: boolean;
      hasLinkedAdAccount: boolean;
      hasSyncedAds: boolean;
    }>;
    canAccessProduct?: boolean;
  } = {},
) {
  const signals = {
    readSignals: jest.fn().mockResolvedValue({
      hasConnectedIntegration: true,
      hasLinkedAdAccount: true,
      hasSyncedAds: true,
      ...options.signals,
    }),
  };

  const subscriptions = {
    resolve: jest.fn().mockResolvedValue({
      canAccessProduct: options.canAccessProduct ?? true,
    }),
  };

  return {
    service: new OnboardingStateService(
      signals as never,
      subscriptions as never,
    ),
    signals,
    subscriptions,
  };
}

describe('OnboardingStateService', () => {
  it('lê os sinais da organização selecionada', async () => {
    const h = buildHarness();

    const result = await h.service.resolve('acc-1', 'org-1');

    expect(h.signals.readSignals).toHaveBeenCalledWith('org-1');
    expect(h.subscriptions.resolve).toHaveBeenCalledWith('acc-1', {
      organizationId: 'org-1',
    });
    expect(result.nextStep).toBe('READY');
  });

  it('período de graça conta como assinatura ativa', async () => {
    // `canAccessProduct` é o mesmo predicado do `EntitlementGuard`. Qualquer
    // outra definição faria o `/me` liberar o que a rota recusa — ou o inverso.
    const h = buildHarness({ canAccessProduct: true });

    const result = await h.service.resolve('acc-1', 'org-1');

    expect(result.hasActiveSubscription).toBe(true);
  });

  it('assinatura vencida para em SUBSCRIBE mesmo com tudo conectado', async () => {
    const h = buildHarness({ canAccessProduct: false });

    const result = await h.service.resolve('acc-1', 'org-1');

    expect(result.nextStep).toBe('SUBSCRIBE');
  });

  it('sem organização não consulta nada', async () => {
    // Os três sinais seriam falsos por construção, não por observação — e a
    // assinatura não é afirmada, porque não foi verificada.
    const h = buildHarness();

    const result = await h.service.resolve('acc-1', null);

    expect(h.signals.readSignals).not.toHaveBeenCalled();
    expect(h.subscriptions.resolve).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasOrganization: false,
      hasActiveSubscription: false,
      hasConnectedIntegration: false,
      hasLinkedAdAccount: false,
      hasSyncedAds: false,
      nextStep: 'CREATE_ORGANIZATION',
    });
  });

  it('conta de plataforma vai para o backoffice, nunca para o onboarding do cliente', async () => {
    // Sem isto o operador sem organização recebia CREATE_ORGANIZATION, e a
    // rota de criar respondia 403 — o /me apontando para uma porta fechada.
    const h = buildHarness();

    const result = await h.service.resolve('op-1', null, {
      platformAccount: true,
    });

    expect(result.nextStep).toBe('USE_BACKOFFICE');
    expect(h.signals.readSignals).not.toHaveBeenCalled();
    expect(h.subscriptions.resolve).not.toHaveBeenCalled();
  });

  it('conta híbrida legada (operador com organização) também vai para o backoffice', async () => {
    const h = buildHarness();

    const result = await h.service.resolve('op-1', 'org-1', {
      platformAccount: true,
    });

    expect(result.nextStep).toBe('USE_BACKOFFICE');
    expect(result.hasOrganization).toBe(false);
  });
});
