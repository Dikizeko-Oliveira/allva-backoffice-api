import {
  conversionTarget,
  nonConversionTarget,
  UNKNOWN_OPTIMIZATION,
  type ConversionEvent,
  type OptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * Tradução do Google Ads para a taxonomia canônica de otimização.
 *
 * ## O que já estava certo, e o que faltava
 *
 * No Google, `metrics.conversions` **já é** a contagem das metas de conversão
 * da campanha — compra, lead, cadastro, ligação, o que a conta tiver marcado
 * como meta dela. A contagem não precisa de tradução, e por isso a conversão
 * aqui é sempre mensurável quando a campanha otimiza para conversão.
 *
 * O que faltava era saber **se** a campanha otimiza para conversão. Uma
 * campanha de vídeo com lance por CPM, ou de pesquisa com "maximizar cliques",
 * tem zero conversões por desenho — e cobrar conversão dela era o mesmo falso
 * positivo do Meta.
 *
 * ## A regra
 *
 * A **estratégia de lance** é a declaração mais direta do que a campanha busca:
 * lances de conversão (`TARGET_CPA`, `MAXIMIZE_CONVERSIONS`, ...) são conversão;
 * lances por clique são tráfego; por impressão ou visualização, alcance. O lance
 * manual por clique é ambíguo — muita campanha de pesquisa usa lance manual e é
 * julgada por CPA —, então vira conversão só quando a campanha tem meta de
 * conversão lançável. Sem saber as metas, a resposta segura é tráfego: deixar de
 * julgar uma conversão custa cobertura; julgar sem meta custa um falso positivo.
 */

/** `ConversionActionCategory` → evento canônico. */
const CATEGORY_EVENT: Readonly<Record<string, ConversionEvent>> = {
  PURCHASE: 'PURCHASE',
  STORE_SALE: 'PURCHASE',
  SIGNUP: 'COMPLETE_REGISTRATION',
  SUBMIT_LEAD_FORM: 'LEAD',
  IMPORTED_LEAD: 'LEAD',
  QUALIFIED_LEAD: 'LEAD',
  CONVERTED_LEAD: 'LEAD',
  REQUEST_QUOTE: 'LEAD',
  PHONE_CALL_LEAD: 'CALL',
  ADD_TO_CART: 'ADD_TO_CART',
  BEGIN_CHECKOUT: 'INITIATED_CHECKOUT',
  SUBSCRIBE_PAID: 'SUBSCRIBE',
  BOOK_APPOINTMENT: 'SCHEDULE',
  CONTACT: 'CONTACT',
  GET_DIRECTIONS: 'FIND_LOCATION',
  STORE_VISIT: 'FIND_LOCATION',
  PAGE_VIEW: 'CONTENT_VIEW',
  DOWNLOAD: 'APP_INSTALL',
};

const CONVERSION_BIDDING = new Set([
  'MAXIMIZE_CONVERSIONS',
  'MAXIMIZE_CONVERSION_VALUE',
  'TARGET_CPA',
  'TARGET_ROAS',
]);

/** Lance que otimiza conversão só quando há meta para otimizar. */
const CONVERSION_IF_GOALS_BIDDING = new Set([
  'MANUAL_CPC',
  'ENHANCED_CPC',
  'COMMISSION',
  'PERCENT_CPC',
]);

const TRAFFIC_BIDDING = new Set(['TARGET_SPEND', 'TARGET_CPC']);

const AWARENESS_BIDDING = new Set([
  'TARGET_CPM',
  'MANUAL_CPM',
  'MANUAL_CPV',
  'TARGET_CPV',
  'TARGET_IMPRESSION_SHARE',
  'FIXED_CPM',
]);

/** Tipos de campanha que só existem otimizando conversão. */
const CONVERSION_CHANNELS = new Set([
  'PERFORMANCE_MAX',
  'SHOPPING',
  'SMART',
  'HOTEL',
  'LOCAL',
  'MULTI_CHANNEL',
]);

/**
 * O evento a partir das categorias das metas lançáveis da campanha.
 *
 * `null` nas categorias = a leitura das metas falhou; o evento fica `OTHER`,
 * ainda mensurável, porque quem conta é a plataforma.
 */
export function eventFromGoalCategories(
  categories: readonly string[] | null,
): ConversionEvent {
  if (!categories || categories.length === 0) return 'OTHER';

  const events = new Set(
    categories.map((category) => CATEGORY_EVENT[category] ?? 'OTHER'),
  );

  return events.size === 1 ? [...events][0] : 'MULTIPLE';
}

export function classifyGoogleCampaign(input: {
  channelType?: string | null;
  biddingStrategyType?: string | null;
  /**
   * Categorias das metas **lançáveis** da campanha. `null` quando a leitura das
   * metas não aconteceu — distinto de `[]`, que é "a campanha não tem meta".
   */
  biddableGoalCategories: readonly string[] | null;
}): OptimizationTarget {
  const bidding = input.biddingStrategyType ?? '';
  const categories = input.biddableGoalCategories;
  const hasGoals = categories !== null && categories.length > 0;
  const event = () => eventFromGoalCategories(categories);

  if (CONVERSION_BIDDING.has(bidding)) return conversionTarget(event(), true);

  if (CONVERSION_IF_GOALS_BIDDING.has(bidding)) {
    return hasGoals
      ? conversionTarget(event(), true)
      : nonConversionTarget('TRAFFIC');
  }

  if (TRAFFIC_BIDDING.has(bidding)) return nonConversionTarget('TRAFFIC');
  if (AWARENESS_BIDDING.has(bidding)) return nonConversionTarget('AWARENESS');

  // Lance não declarado ou desconhecido: o tipo de canal decide quando ele só
  // existe para conversão.
  if (CONVERSION_CHANNELS.has(input.channelType ?? '')) {
    return conversionTarget(event(), true);
  }

  return UNKNOWN_OPTIMIZATION;
}
