import { resolveSupportOnboarding } from './support-onboarding';

const NOTHING = {
  organizationProfileComplete: false,
  teamInvited: false,
  notificationPreferencesSet: false,
};

const NO_PRODUCT = {
  hasConnectedIntegration: false,
  hasLinkedAdAccount: false,
  hasSyncedAds: false,
};

describe('resolveSupportOnboarding', () => {
  it('conta zero e ainda assim publica os cinco passos', () => {
    const checklist = resolveSupportOnboarding(NOTHING, NO_PRODUCT);

    expect(checklist.steps).toHaveLength(5);
    expect(checklist.completedCount).toBe(0);
    expect(checklist.totalCount).toBe(5);
    expect(checklist.progress).toBe(0);
    expect(checklist.steps.every((step) => !step.completed)).toBe(true);
  });

  it('a ordem do array é a ordem da tela', () => {
    expect(
      resolveSupportOnboarding(NOTHING, NO_PRODUCT).steps.map(
        (step) => step.id,
      ),
    ).toEqual([
      'ORGANIZATION_PROFILE',
      'INVITE_TEAM',
      'CONNECT_INTEGRATIONS',
      'NOTIFICATION_PREFERENCES',
      'REVIEW_INDICATORS',
    ]);
  });

  /**
   * Credencial conectada sem conta vinculada não traz um anúncio sequer.
   * Marcar o passo ali mandaria a pessoa para a próxima etapa achando que
   * terminou esta — e a etapa seguinte é justamente "veja seus indicadores",
   * que estaria vazia.
   */
  it('integração só conta com credencial conectada E conta vinculada', () => {
    const half = resolveSupportOnboarding(NOTHING, {
      ...NO_PRODUCT,
      hasConnectedIntegration: true,
    });
    expect(
      half.steps.find((step) => step.id === 'CONNECT_INTEGRATIONS')!.completed,
    ).toBe(false);

    const whole = resolveSupportOnboarding(NOTHING, {
      ...NO_PRODUCT,
      hasConnectedIntegration: true,
      hasLinkedAdAccount: true,
    });
    expect(
      whole.steps.find((step) => step.id === 'CONNECT_INTEGRATIONS')!.completed,
    ).toBe(true);
  });

  it('os passos são independentes — concluir fora de ordem conta igual', () => {
    const checklist = resolveSupportOnboarding(
      { ...NOTHING, notificationPreferencesSet: true },
      NO_PRODUCT,
    );

    expect(checklist.completedCount).toBe(1);
    expect(checklist.progress).toBe(20);
  });

  it('tudo feito é 100, e o arredondamento é inteiro', () => {
    const all = resolveSupportOnboarding(
      {
        organizationProfileComplete: true,
        teamInvited: true,
        notificationPreferencesSet: true,
      },
      {
        hasConnectedIntegration: true,
        hasLinkedAdAccount: true,
        hasSyncedAds: true,
      },
    );

    expect(all.completedCount).toBe(5);
    expect(all.progress).toBe(100);

    // 2/5 = 40, e não 40.000000000000004 — a barra recebe inteiro.
    const two = resolveSupportOnboarding(
      { ...NOTHING, organizationProfileComplete: true, teamInvited: true },
      NO_PRODUCT,
    );
    expect(two.progress).toBe(40);
    expect(Number.isInteger(two.progress)).toBe(true);
  });
});
