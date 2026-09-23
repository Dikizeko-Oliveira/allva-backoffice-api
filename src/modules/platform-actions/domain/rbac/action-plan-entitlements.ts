import { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import type { EnforcedFeatureKey } from 'src/modules/plans/domain/plan-entitlements';

/**
 * Que linha do catálogo de planos cada tipo de ação consome.
 *
 * `Record<AdActionType, EnforcedFeatureKey>` **total**, pelo mesmo motivo que
 * `ACTION_TYPE_PERMISSION` é total: uma ação nova não compila até alguém
 * decidir em qual plano ela entra. Com `Partial` e um default, a ação nasceria
 * no plano mais barato e o esquecimento só apareceria na fatura de quem não
 * pagou por ela.
 *
 * ## Este eixo não é o do RBAC, e confundi-los seria um erro
 *
 * `ACTION_TYPE_PERMISSION` separa por **blast radius**: `PAUSE_CAMPAIGN` para
 * dinheiro, `ADJUST_CAMPAIGN_BUDGET` o move, então a segunda exige permissão
 * sensível. É sobre *quem*, dentro da organização, pode puxar o gatilho.
 *
 * O mapa abaixo separa por **nível de entidade**: agir no anúncio é o trabalho
 * diário de um gestor de tráfego solo; agir em conjunto e campanha é operação de
 * agência. É sobre *o que a organização comprou*.
 *
 * Os dois discordam de propósito. `PAUSE_AD_SET` é `actions:execute` (baixo
 * estrago, qualquer analista pode) e ao mesmo tempo `budget-actions` (só a
 * partir do Profissional). Fundi-los faria um dos dois eixos desaparecer, e o
 * que desapareceria é o comercial — porque é o que não tem teste de segurança
 * cobrando.
 */
export const ACTION_TYPE_FEATURE: Record<AdActionType, EnforcedFeatureKey> = {
  // Nível AD — o trabalho diário, presente em todo plano pago.
  PAUSE_AD: 'ad-actions',
  ENABLE_AD: 'ad-actions',
  ARCHIVE_AD: 'ad-actions',
  DUPLICATE_AD: 'ad-actions',
  REPLACE_CREATIVE: 'ad-actions',
  REPLACE_COPY: 'ad-actions',
  REPLACE_CTA: 'ad-actions',

  // Acima do anúncio — conjunto, campanha e orçamento.
  PAUSE_AD_SET: 'budget-actions',
  ENABLE_AD_SET: 'budget-actions',
  ADJUST_AD_SET_BUDGET: 'budget-actions',
  PAUSE_CAMPAIGN: 'budget-actions',
  ENABLE_CAMPAIGN: 'budget-actions',
  ADJUST_CAMPAIGN_BUDGET: 'budget-actions',
};

export function featureFor(type: AdActionType): EnforcedFeatureKey {
  return ACTION_TYPE_FEATURE[type];
}
