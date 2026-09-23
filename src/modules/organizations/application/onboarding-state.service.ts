import { Injectable } from '@nestjs/common';
import {
  OnboardingState,
  OnboardingStep,
  resolveNextStep,
} from 'src/modules/organizations/domain/onboarding';
import { OnboardingStatePortInterface } from 'src/modules/organizations/domain/ports';
import { SubscriptionContextResolver } from 'src/modules/subscriptions/access/application/subscription-context.resolver';

export type OnboardingSummary = OnboardingState & { nextStep: OnboardingStep };

/**
 * Monta o estado de onboarding que `GET /auth/me` publica.
 *
 * Serviço separado do use case por duas razões. A primeira é teto: §16.6 limita
 * use case a ~150 linhas e `GetMeContextUseCase` já ocupava quase tudo. A
 * segunda é que este cálculo tem chamadores futuros óbvios — a dashboard e a
 * tela de integrações fazem a mesma pergunta —, e enterrá-lo dentro do `/me`
 * garantiria que o segundo chamador o reimplementasse.
 */
@Injectable()
export class OnboardingStateService {
  constructor(
    private readonly signals: OnboardingStatePortInterface,
    private readonly subscriptions: SubscriptionContextResolver,
  ) {}

  async resolve(
    accountId: string,
    organizationId: string | null,
    options: { platformAccount?: boolean } = {},
  ): Promise<OnboardingSummary> {
    /**
     * Conta de plataforma sai antes de qualquer consulta: nenhum sinal de
     * cliente muda a resposta, e mesmo uma conta híbrida legada (operador que
     * possui organização) não pode ser mandada para um passo cujas rotas a
     * recusam. Os booleanos ficam falsos porque é o que o produto enxerga
     * para ela — nada.
     */
    if (options.platformAccount) {
      return {
        hasOrganization: false,
        hasActiveSubscription: false,
        hasConnectedIntegration: false,
        hasLinkedAdAccount: false,
        hasSyncedAds: false,
        nextStep: 'USE_BACKOFFICE',
      };
    }

    /**
     * Sem organização não há o que perguntar: `integrations` e `ads` são
     * escopados por ela, então os três sinais seriam falsos por construção, não
     * por observação. Devolver o passo direto evita três consultas cuja resposta
     * já é conhecida.
     *
     * A assinatura também não é consultada aqui, e isso é deliberado: o passo é
     * criar a organização de qualquer forma, e uma conta legada nesse estado
     * quase certamente tem assinatura — dizer `hasActiveSubscription: false`
     * seria afirmar algo não verificado.
     */
    if (!organizationId) {
      return {
        hasOrganization: false,
        hasActiveSubscription: false,
        hasConnectedIntegration: false,
        hasLinkedAdAccount: false,
        hasSyncedAds: false,
        nextStep: 'CREATE_ORGANIZATION',
      };
    }

    const [signals, subscription] = await Promise.all([
      this.signals.readSignals(organizationId),
      this.subscriptions.resolve(accountId, { organizationId }),
    ]);

    const state: OnboardingState = {
      hasOrganization: true,
      /**
       * `canAccessProduct`, e não "existe assinatura".
       *
       * É o mesmo predicado que o `EntitlementGuard` aplica — inclui período de
       * graça e exclui vencida. Qualquer outra definição aqui faria o `/me`
       * dizer que dá para conectar uma plataforma enquanto a rota responde 403.
       */
      hasActiveSubscription: subscription.canAccessProduct,
      ...signals,
    };

    return { ...state, nextStep: resolveNextStep(state) };
  }
}
