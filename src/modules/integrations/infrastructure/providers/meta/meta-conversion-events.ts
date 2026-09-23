import {
  conversionTarget,
  nonConversionTarget,
  UNKNOWN_OPTIMIZATION,
  type ConversionEvent,
  type OptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * Tradução do vocabulário da Meta para a taxonomia canônica de otimização — e
 * **o que contar** como conversão em cada caso.
 *
 * ## Por que isto existe
 *
 * O insights da Meta não tem uma coluna "conversões": tem `actions`, uma lista
 * de `{ action_type, value }` com dezenas de tipos (compra, lead, cadastro,
 * carrinho, instalação, mensagem...). Até aqui o provider contava só
 * `purchase`/`omni_purchase`, qualquer que fosse o evento do conjunto — e um
 * anúncio de lead aparecia com zero conversões e recebia recomendação de pausa.
 *
 * Agora a conversão de um anúncio é o evento que **o conjunto dele otimiza**:
 * `optimization_goal` diz o tipo de resultado, e `promoted_object` diz qual
 * evento (`custom_event_type`) ou qual conversão personalizada
 * (`custom_conversion_id`).
 *
 * ## Um tipo, nunca a soma
 *
 * A Meta reporta o mesmo evento em vários `action_type` sobrepostos:
 * `omni_purchase` (todas as origens), `purchase`, `offsite_conversion.
 * fb_pixel_purchase` (só pixel), `onsite_web_purchase`... Somá-los contaria a
 * mesma compra três vezes. Cada evento tem uma **lista de preferência**, e conta
 * o primeiro tipo presente na linha — o mais abrangente primeiro.
 *
 * ## Mensurável ou não
 *
 * Quando a Meta otimiza para algo que o insights não separa — evento
 * personalizado por nome (`custom_event_str`), retenção de app, ligação
 * qualificada —, o anúncio continua classificado como `CONVERSION`, mas com
 * `conversionMeasurable: false`. O número que leríamos não seria o do evento, e
 * julgar sobre ele seria inventar evidência: os detectores de conversão ficam
 * de fora e a tela diz por quê.
 *
 * > **Validação pendente.** Os nomes de `action_type` seguem a documentação
 * > da Graph API e ainda não foram conferidos contra uma conta real — não havia
 * > nenhuma conectada quando este mapa foi escrito. Os primeiros parceiros de
 * > lançamento devem confirmar, evento a evento, que o número bate com a coluna
 * > "Resultados" do Gerenciador de Anúncios.
 */

export type MetaPromotedObject = {
  custom_event_type?: string;
  custom_conversion_id?: string;
  custom_event_str?: string;
  pixel_id?: string;
  application_id?: string;
  object_store_url?: string;
  page_id?: string;
};

export type MetaConversionSpec = {
  target: OptimizationTarget;
  /**
   * `action_type` a contar, em ordem de preferência. Vazio quando o evento não
   * é mensurável — a contagem cai para a compra incidental (ver
   * `countMetaConversions`).
   */
  actionTypes: readonly string[];
};

/** Os tipos de cada evento, do mais abrangente ao mais específico. */
const ACTION_TYPES: Partial<Record<ConversionEvent, readonly string[]>> = {
  PURCHASE: [
    'omni_purchase',
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
    'onsite_web_purchase',
    'onsite_conversion.purchase',
    'app_custom_event.fb_mobile_purchase',
  ],
  LEAD: [
    'lead',
    'offsite_conversion.fb_pixel_lead',
    'onsite_conversion.lead_grouped',
    'leadgen_grouped',
    'onsite_web_lead',
  ],
  COMPLETE_REGISTRATION: [
    'omni_complete_registration',
    'complete_registration',
    'offsite_conversion.fb_pixel_complete_registration',
    'app_custom_event.fb_mobile_complete_registration',
  ],
  ADD_TO_CART: [
    'omni_add_to_cart',
    'add_to_cart',
    'offsite_conversion.fb_pixel_add_to_cart',
    'app_custom_event.fb_mobile_add_to_cart',
  ],
  INITIATED_CHECKOUT: [
    'omni_initiated_checkout',
    'initiate_checkout',
    'offsite_conversion.fb_pixel_initiate_checkout',
    'app_custom_event.fb_mobile_initiated_checkout',
  ],
  ADD_PAYMENT_INFO: [
    'add_payment_info',
    'offsite_conversion.fb_pixel_add_payment_info',
    'app_custom_event.fb_mobile_add_payment_info',
  ],
  ADD_TO_WISHLIST: [
    'add_to_wishlist',
    'offsite_conversion.fb_pixel_add_to_wishlist',
    'app_custom_event.fb_mobile_add_to_wishlist',
  ],
  CONTENT_VIEW: [
    'omni_view_content',
    'view_content',
    'offsite_conversion.fb_pixel_view_content',
    'app_custom_event.fb_mobile_content_view',
  ],
  SEARCH: [
    'omni_search',
    'search',
    'offsite_conversion.fb_pixel_search',
    'app_custom_event.fb_mobile_search',
  ],
  CONTACT: ['contact_total', 'contact_website', 'contact_mobile_app'],
  SCHEDULE: ['schedule_total', 'schedule_website', 'schedule_mobile_app'],
  START_TRIAL: [
    'start_trial_total',
    'start_trial_website',
    'start_trial_mobile_app',
  ],
  SUBMIT_APPLICATION: [
    'submit_application_total',
    'submit_application_website',
    'submit_application_mobile_app',
  ],
  SUBSCRIBE: ['subscribe_total', 'subscribe_website', 'subscribe_mobile_app'],
  DONATE: ['donate_total', 'donate_website', 'donate_mobile_app'],
  FIND_LOCATION: [
    'find_location_total',
    'find_location_website',
    'find_location_mobile_app',
  ],
  CUSTOMIZE_PRODUCT: [
    'customize_product_total',
    'customize_product_website',
    'customize_product_mobile_app',
  ],
  APP_INSTALL: ['omni_app_install', 'mobile_app_install', 'app_install'],
  MESSAGING_CONVERSATION: [
    'onsite_conversion.messaging_conversation_started_7d',
  ],
};

/** Formulário nativo (Lead Ads): o lead do formulário vem antes do agregado. */
const INSTANT_FORM_LEAD_TYPES: readonly string[] = [
  'onsite_conversion.lead_grouped',
  'leadgen_grouped',
  'lead',
];

/** Eventos de app que não têm evento canônico próprio, mas têm tipo próprio. */
const APP_EVENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  LEVEL_ACHIEVED: [
    'omni_level_achieved',
    'app_custom_event.fb_mobile_level_achieved',
  ],
  ACHIEVEMENT_UNLOCKED: [
    'omni_achievement_unlocked',
    'app_custom_event.fb_mobile_achievement_unlocked',
  ],
  SPENT_CREDITS: [
    'omni_spend_credits',
    'app_custom_event.fb_mobile_spent_credits',
  ],
  RATE: ['omni_rate', 'app_custom_event.fb_mobile_rate'],
  TUTORIAL_COMPLETION: [
    'omni_tutorial_completion',
    'app_custom_event.fb_mobile_tutorial_completion',
  ],
};

/** `promoted_object.custom_event_type` → evento canônico. */
const CUSTOM_EVENT_TYPE: Readonly<Record<string, ConversionEvent>> = {
  PURCHASE: 'PURCHASE',
  LEAD: 'LEAD',
  COMPLETE_REGISTRATION: 'COMPLETE_REGISTRATION',
  ADD_TO_CART: 'ADD_TO_CART',
  INITIATED_CHECKOUT: 'INITIATED_CHECKOUT',
  ADD_PAYMENT_INFO: 'ADD_PAYMENT_INFO',
  ADD_TO_WISHLIST: 'ADD_TO_WISHLIST',
  CONTENT_VIEW: 'CONTENT_VIEW',
  SEARCH: 'SEARCH',
  CONTACT: 'CONTACT',
  SCHEDULE: 'SCHEDULE',
  START_TRIAL: 'START_TRIAL',
  SUBMIT_APPLICATION: 'SUBMIT_APPLICATION',
  SUBSCRIBE: 'SUBSCRIBE',
  DONATE: 'DONATE',
  FIND_LOCATION: 'FIND_LOCATION',
  CUSTOMIZE_PRODUCT: 'CUSTOMIZE_PRODUCT',
  MESSAGING_CONVERSATION_STARTED_7D: 'MESSAGING_CONVERSATION',
};

const TRAFFIC_GOALS = new Set(['LINK_CLICKS', 'LANDING_PAGE_VIEWS']);

const AWARENESS_GOALS = new Set([
  'REACH',
  'IMPRESSIONS',
  'AD_RECALL_LIFT',
  'THRUPLAY',
  'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS',
]);

const ENGAGEMENT_GOALS = new Set([
  'POST_ENGAGEMENT',
  'PAGE_LIKES',
  'EVENT_RESPONSES',
  'ENGAGED_USERS',
  'VISIT_INSTAGRAM_PROFILE',
  'PROFILE_VISIT',
  'PROFILE_AND_PAGE_ENGAGEMENT',
  'REMINDERS_SET',
  'SUBSCRIBERS',
  'DERIVED_EVENTS',
]);

/** Metas de otimização cujo evento vem do `promoted_object`. */
const EVENT_DRIVEN_GOALS = new Set([
  'OFFSITE_CONVERSIONS',
  'VALUE',
  'APP_INSTALLS_AND_OFFSITE_CONVERSIONS',
  'ADVERTISER_SILOED_VALUE',
  'IN_APP_VALUE',
]);

function measurable(event: ConversionEvent): MetaConversionSpec {
  return {
    target: conversionTarget(event, true),
    actionTypes: ACTION_TYPES[event] ?? [],
  };
}

function unmeasurable(event: ConversionEvent): MetaConversionSpec {
  return { target: conversionTarget(event, false), actionTypes: [] };
}

function nonConversion(
  cls: 'TRAFFIC' | 'AWARENESS' | 'ENGAGEMENT',
): MetaConversionSpec {
  return { target: nonConversionTarget(cls), actionTypes: [] };
}

/**
 * O evento do `promoted_object`, quando a meta é "otimizar para um evento".
 *
 * `valueDefault` é o evento assumido quando nada foi declarado: otimização de
 * valor é, na prática da Meta, valor de compra.
 */
function specFromPromotedObject(
  promoted: MetaPromotedObject | undefined,
  valueDefault: ConversionEvent | null,
): MetaConversionSpec {
  // Conversão personalizada: o tipo carrega o id, e é contável um a um.
  if (promoted?.custom_conversion_id) {
    return {
      target: conversionTarget('CUSTOM_CONVERSION', true),
      actionTypes: [
        `offsite_conversion.custom.${promoted.custom_conversion_id}`,
      ],
    };
  }

  const type = promoted?.custom_event_type;

  if (type && CUSTOM_EVENT_TYPE[type])
    return measurable(CUSTOM_EVENT_TYPE[type]);

  if (type && APP_EVENT_TYPES[type]) {
    return {
      target: conversionTarget('APP_EVENT', true),
      actionTypes: APP_EVENT_TYPES[type],
    };
  }

  // Retenção de app, evento personalizado por nome, agendamento de serviço,
  // interação com listagem: a Meta otimiza para eles, mas o insights não os
  // separa num tipo próprio. Classificado como conversão, e não mensurável.
  if (type === 'D2_RETENTION' || type === 'D7_RETENTION') {
    return unmeasurable('APP_EVENT');
  }
  if (type) return unmeasurable('OTHER');

  if (valueDefault) return measurable(valueDefault);

  // "Otimizar para um evento" sem evento declarado: não há o que contar.
  return unmeasurable('OTHER');
}

/**
 * A otimização de um **conjunto** — `optimization_goal` + `promoted_object`.
 *
 * Devolve `null` quando a meta não diz nada (`NONE`, automática ou nova e
 * desconhecida): aí vale o objetivo da campanha, em `resolveMetaCampaign...`.
 */
export function resolveMetaAdSetOptimization(input: {
  optimizationGoal?: string | null;
  promotedObject?: MetaPromotedObject;
}): MetaConversionSpec | null {
  const goal = input.optimizationGoal ?? '';

  if (EVENT_DRIVEN_GOALS.has(goal)) {
    const valueDefault =
      goal === 'VALUE' ||
      goal === 'IN_APP_VALUE' ||
      goal === 'ADVERTISER_SILOED_VALUE'
        ? 'PURCHASE'
        : goal === 'APP_INSTALLS_AND_OFFSITE_CONVERSIONS'
          ? 'APP_INSTALL'
          : null;
    return specFromPromotedObject(input.promotedObject, valueDefault);
  }

  switch (goal) {
    case 'LEAD_GENERATION':
    case 'QUALITY_LEAD':
      return {
        target: conversionTarget('LEAD', true),
        actionTypes: INSTANT_FORM_LEAD_TYPES,
      };
    case 'APP_INSTALLS':
      return measurable('APP_INSTALL');
    case 'CONVERSATIONS':
      return measurable('MESSAGING_CONVERSATION');
    case 'MESSAGING_PURCHASE_CONVERSION':
      return measurable('PURCHASE');
    case 'MESSAGING_APPOINTMENT_CONVERSION':
      return unmeasurable('SCHEDULE');
    case 'QUALITY_CALL':
    case 'MEANINGFUL_CALL_ATTEMPT':
      return unmeasurable('CALL');
  }

  if (TRAFFIC_GOALS.has(goal)) return nonConversion('TRAFFIC');
  if (AWARENESS_GOALS.has(goal)) return nonConversion('AWARENESS');
  if (ENGAGEMENT_GOALS.has(goal)) return nonConversion('ENGAGEMENT');

  return null;
}

/**
 * A otimização de uma **campanha** pelo objetivo — o fallback quando o conjunto
 * não declara meta. Cobre os objetivos ODAX (`OUTCOME_*`) e os legados.
 */
export function resolveMetaCampaignOptimization(
  objective: string | null | undefined,
): MetaConversionSpec {
  switch (objective ?? '') {
    case 'OUTCOME_SALES':
    case 'CONVERSIONS':
    case 'PRODUCT_CATALOG_SALES':
      return measurable('PURCHASE');
    case 'OUTCOME_LEADS':
    case 'LEAD_GENERATION':
      return measurable('LEAD');
    case 'OUTCOME_APP_PROMOTION':
    case 'APP_INSTALLS':
    case 'MOBILE_APP_INSTALLS':
      return measurable('APP_INSTALL');
    case 'MESSAGES':
      return measurable('MESSAGING_CONVERSATION');
    case 'OUTCOME_TRAFFIC':
    case 'LINK_CLICKS':
      return nonConversion('TRAFFIC');
    case 'OUTCOME_AWARENESS':
    case 'REACH':
    case 'BRAND_AWARENESS':
    case 'VIDEO_VIEWS':
    case 'STORE_VISITS':
    case 'LOCAL_AWARENESS':
      return nonConversion('AWARENESS');
    case 'OUTCOME_ENGAGEMENT':
    case 'POST_ENGAGEMENT':
    case 'PAGE_LIKES':
    case 'EVENT_RESPONSES':
      return nonConversion('ENGAGEMENT');
    default:
      return { target: UNKNOWN_OPTIMIZATION, actionTypes: [] };
  }
}

/**
 * O que contar quando o anúncio **não** é julgado por conversão.
 *
 * Tráfego, alcance, evento não mensurável ou objetivo desconhecido: a série
 * continua registrando a compra que acontecer — é receita real, e o painel
 * cross-channel a soma —, mas nenhum detector de conversão a lê, porque o
 * portão de objetivo os barra antes.
 */
const INCIDENTAL_PURCHASE: readonly string[] = ACTION_TYPES.PURCHASE ?? [];

type ActionEntry = { action_type: string; value: string };

function firstPresent(
  entries: ActionEntry[] | undefined,
  types: readonly string[],
): { type: string; value: number } | null {
  if (!entries?.length || types.length === 0) return null;

  for (const type of types) {
    const entry = entries.find((candidate) => candidate.action_type === type);
    if (!entry) continue;
    const value = Number(entry.value);
    if (Number.isFinite(value)) return { type, value };
  }

  return null;
}

/**
 * Conversões, receita e custo por conversão de uma linha de insights, **pelo
 * evento do conjunto**.
 *
 * A receita e o custo vêm do **mesmo** `action_type` que a contagem usou: somar
 * a contagem de lead com o valor de compra produziria um "ROAS de lead" que não
 * mede nada.
 */
export function countMetaConversions(
  row: {
    actions?: ActionEntry[];
    action_values?: ActionEntry[];
    cost_per_action_type?: ActionEntry[];
  },
  spec: MetaConversionSpec | null,
): { conversions: number; revenue: number; cpa: number | null } {
  const counted =
    spec &&
    spec.target.optimizationClass === 'CONVERSION' &&
    spec.target.conversionMeasurable &&
    spec.actionTypes.length > 0
      ? spec.actionTypes
      : INCIDENTAL_PURCHASE;

  const hit = firstPresent(row.actions, counted);
  if (!hit) return { conversions: 0, revenue: 0, cpa: null };

  const value = firstPresent(row.action_values, [hit.type]);
  const cost = firstPresent(row.cost_per_action_type, [hit.type]);

  return {
    conversions: hit.value,
    revenue: value?.value ?? 0,
    cpa: cost?.value ?? null,
  };
}
