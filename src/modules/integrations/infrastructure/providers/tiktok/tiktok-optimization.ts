import {
  conversionTarget,
  nonConversionTarget,
  UNKNOWN_OPTIMIZATION,
  type ConversionEvent,
  type OptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * Tradução do TikTok para a taxonomia canônica de otimização.
 *
 * No TikTok, a métrica `conversion` do relatório já é a contagem do **evento de
 * otimização do grupo** — compra, formulário, cadastro, instalação... A
 * contagem não precisa de tradução, e a conversão é mensurável sempre que o
 * grupo otimiza para conversão.
 *
 * O que faltava era a classe: um grupo com meta `REACH`, `CLICK` ou
 * `VIDEO_VIEW` tem `conversion = 0` por desenho, e cobrar conversão dele era o
 * mesmo falso positivo do Meta.
 */

/** `optimization_event` (pixel e app) → evento canônico. */
const OPTIMIZATION_EVENT: Readonly<Record<string, ConversionEvent>> = {
  // Pixel (web)
  SHOPPING: 'PURCHASE',
  COMPLETE_PAYMENT: 'PURCHASE',
  ON_WEB_ORDER: 'PURCHASE',
  INITIATE_ORDER: 'INITIATED_CHECKOUT',
  ON_WEB_CART: 'ADD_TO_CART',
  ADD_BILLING: 'ADD_PAYMENT_INFO',
  ON_WEB_DETAIL: 'CONTENT_VIEW',
  ON_WEB_SEARCH: 'SEARCH',
  ON_WEB_ADD_TO_WISHLIST: 'ADD_TO_WISHLIST',
  ON_WEB_REGISTER: 'COMPLETE_REGISTRATION',
  ON_WEB_SUBSCRIBE: 'SUBSCRIBE',
  FORM: 'LEAD',
  CONSULT: 'CONTACT',
  // App
  ACTIVE: 'APP_INSTALL',
  INSTALL: 'APP_INSTALL',
  ACTIVE_PAY: 'PURCHASE',
  ACTIVE_REGISTER: 'COMPLETE_REGISTRATION',
  IN_APP_ORDER: 'PURCHASE',
  IN_APP_CART: 'ADD_TO_CART',
  IN_APP_DETAIL_UV: 'CONTENT_VIEW',
  NEXT_DAY_OPEN: 'APP_EVENT',
  LOAN_APPLY: 'SUBMIT_APPLICATION',
  PURCHASE: 'PURCHASE',
};

const CONVERSION_GOALS = new Set([
  'CONVERT',
  'VALUE',
  'AUTOMATIC_VALUE_OPTIMIZATION',
  'IN_APP_EVENT',
]);

const TRAFFIC_GOALS = new Set([
  'CLICK',
  'TRAFFIC_LANDING_PAGE_VIEW',
  'DESTINATION_VISIT',
  'PAGE_VISIT',
]);

const AWARENESS_GOALS = new Set([
  'REACH',
  'SHOW',
  'VIDEO_VIEW',
  'ENGAGED_VIEW',
  'ENGAGED_VIEW_FIFTEEN',
]);

const ENGAGEMENT_GOALS = new Set([
  'FOLLOWERS',
  'PROFILE_VIEWS',
  'ENGAGEMENT',
  'MT_LIVE_ROOM',
  'PRODUCT_CLICK_IN_LIVE',
]);

/**
 * A otimização de um **grupo** — `optimization_goal` + `optimization_event`.
 * `null` quando a meta não diz nada; aí vale o objetivo da campanha.
 */
export function classifyTikTokAdGroup(input: {
  optimizationGoal?: string | null;
  optimizationEvent?: string | null;
}): OptimizationTarget | null {
  const goal = input.optimizationGoal ?? '';
  const event = input.optimizationEvent
    ? (OPTIMIZATION_EVENT[input.optimizationEvent] ?? 'OTHER')
    : null;

  if (CONVERSION_GOALS.has(goal)) {
    const fallback: ConversionEvent =
      goal === 'VALUE' || goal === 'AUTOMATIC_VALUE_OPTIMIZATION'
        ? 'PURCHASE'
        : goal === 'IN_APP_EVENT'
          ? 'APP_EVENT'
          : 'OTHER';
    return conversionTarget(event ?? fallback, true);
  }

  switch (goal) {
    case 'INSTALL':
      return conversionTarget('APP_INSTALL', true);
    case 'LEAD_GENERATION':
    case 'PREFERRED_LEAD':
      return conversionTarget('LEAD', true);
    case 'CONVERSATION':
      return conversionTarget('MESSAGING_CONVERSATION', true);
  }

  if (TRAFFIC_GOALS.has(goal)) return nonConversionTarget('TRAFFIC');
  if (AWARENESS_GOALS.has(goal)) return nonConversionTarget('AWARENESS');
  if (ENGAGEMENT_GOALS.has(goal)) return nonConversionTarget('ENGAGEMENT');

  return null;
}

/** A otimização de uma **campanha** pelo `objective_type` — o fallback. */
export function classifyTikTokCampaign(
  objectiveType: string | null | undefined,
): OptimizationTarget {
  switch (objectiveType ?? '') {
    case 'PRODUCT_SALES':
    case 'WEB_CONVERSIONS':
    case 'CONVERSIONS':
    case 'SHOP_PURCHASES':
      return conversionTarget('PURCHASE', true);
    case 'LEAD_GENERATION':
      return conversionTarget('LEAD', true);
    case 'APP_PROMOTION':
    case 'APP_INSTALL':
      return conversionTarget('APP_INSTALL', true);
    case 'TRAFFIC':
      return nonConversionTarget('TRAFFIC');
    case 'REACH':
    case 'RF_REACH':
    case 'VIDEO_VIEWS':
      return nonConversionTarget('AWARENESS');
    case 'ENGAGEMENT':
    case 'COMMUNITY_INTERACTION':
      return nonConversionTarget('ENGAGEMENT');
    default:
      return UNKNOWN_OPTIMIZATION;
  }
}
