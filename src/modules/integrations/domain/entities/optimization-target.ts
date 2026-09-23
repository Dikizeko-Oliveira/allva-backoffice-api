/**
 * **Para que o anúncio foi otimizado** — a pergunta que decide o que é
 * "conversão" para ele, e se faz sentido cobrar conversão dele.
 *
 * ## O defeito que isto corrige
 *
 * Até aqui "conversão" era uma coluna só, e cada plataforma a enchia do seu
 * jeito: no Meta, **só compra** (`purchase`/`omni_purchase`), qualquer que fosse
 * o evento que o conjunto otimizava. E nenhum detector perguntava o objetivo da
 * campanha. Um anúncio de lead no Meta aparecia com zero conversões; um de
 * alcance ou tráfego, em qualquer plataforma, também. Com R$ 50 gastos numa
 * janela madura, `ZERO_CONVERSIONS` disparava e o motor recomendava **pausar** —
 * o falso positivo que P7 existe para impedir.
 *
 * ## As duas perguntas, separadas
 *
 * - `optimizationClass` responde **"cobrar conversão deste anúncio faz
 *   sentido?"**. Só `CONVERSION` entra nos detectores que dependem de conversão
 *   e no componente `audienceFit` do score. Tráfego, alcance e engajamento
 *   continuam passando por todos os detectores de entrega e de criativo — CTR,
 *   fadiga, frequência, feedback negativo, aprendizado, conteúdo duplicado.
 * - `conversionEvent` responde **"o que conta como conversão aqui?"** — compra,
 *   lead, cadastro, instalação, mensagem... É o que torna comparável o CPA de
 *   dois anúncios: custo por lead e custo por compra não cabem na mesma mediana.
 *
 * E uma terceira, que só existe por honestidade: `conversionMeasurable` diz se
 * **conseguimos contar** esse evento. A plataforma pode otimizar para um evento
 * personalizado que o relatório dela agrega com outros; aí o número que
 * leríamos não é o do evento, e julgar sobre ele seria inventar evidência.
 * Não mensurável ⇒ os detectores de conversão não rodam, e a tela diz por quê.
 *
 * ## Onde a tradução mora (P6)
 *
 * Cada provider traduz o vocabulário da sua plataforma (objetivo, meta de
 * otimização, evento, estratégia de lance) para esta taxonomia, **dentro de
 * `infrastructure/providers/`**. Daqui para dentro do domínio nenhum código
 * conhece `OFFSITE_CONVERSIONS`, `TARGET_CPA` ou `ON_WEB_ORDER`.
 */

export const OPTIMIZATION_CLASSES = [
  'CONVERSION',
  'TRAFFIC',
  'AWARENESS',
  'ENGAGEMENT',
  'UNKNOWN',
] as const;

export type OptimizationClass = (typeof OPTIMIZATION_CLASSES)[number];

/**
 * O vocabulário canônico de eventos de conversão.
 *
 * Cobre os eventos-padrão das três plataformas (web, app, mensagens,
 * formulários nativos). `MULTIPLE` é a campanha do Google que otimiza para mais
 * de uma categoria de meta ao mesmo tempo; `OTHER` é o evento que existe na
 * plataforma mas não tem equivalente aqui — ele ainda é mensurável quando a
 * plataforma o conta por nós (Google, TikTok).
 */
export const CONVERSION_EVENTS = [
  'PURCHASE',
  'LEAD',
  'COMPLETE_REGISTRATION',
  'ADD_TO_CART',
  'INITIATED_CHECKOUT',
  'ADD_PAYMENT_INFO',
  'ADD_TO_WISHLIST',
  'CONTENT_VIEW',
  'SEARCH',
  'CONTACT',
  'SCHEDULE',
  'START_TRIAL',
  'SUBMIT_APPLICATION',
  'SUBSCRIBE',
  'DONATE',
  'FIND_LOCATION',
  'CUSTOMIZE_PRODUCT',
  'APP_INSTALL',
  'APP_EVENT',
  'MESSAGING_CONVERSATION',
  'CALL',
  'CUSTOM_CONVERSION',
  'MULTIPLE',
  'OTHER',
] as const;

export type ConversionEvent = (typeof CONVERSION_EVENTS)[number];

export type OptimizationTarget = {
  optimizationClass: OptimizationClass;
  /** `null` fora de `CONVERSION`: tráfego e alcance não têm evento de conversão. */
  conversionEvent: ConversionEvent | null;
  /** Conseguimos contar o evento? Só faz sentido com `CONVERSION`. */
  conversionMeasurable: boolean;
};

/** De onde veio o objetivo resolvido para um anúncio. */
export type OptimizationSource = 'AD_SET' | 'CAMPAIGN' | 'NONE';

export type ResolvedOptimization = OptimizationTarget & {
  source: OptimizationSource;
};

export const UNKNOWN_OPTIMIZATION: OptimizationTarget = {
  optimizationClass: 'UNKNOWN',
  conversionEvent: null,
  conversionMeasurable: false,
};

export function conversionTarget(
  event: ConversionEvent,
  measurable = true,
): OptimizationTarget {
  return {
    optimizationClass: 'CONVERSION',
    conversionEvent: event,
    conversionMeasurable: measurable,
  };
}

export function nonConversionTarget(
  optimizationClass: Exclude<OptimizationClass, 'CONVERSION'>,
): OptimizationTarget {
  return {
    optimizationClass,
    conversionEvent: null,
    conversionMeasurable: false,
  };
}

/** Normaliza o que veio do banco — coluna nula ou valor fora do vocabulário. */
export function toOptimizationTarget(input: {
  optimizationClass: string | null | undefined;
  conversionEvent: string | null | undefined;
  conversionMeasurable: boolean | null | undefined;
}): OptimizationTarget | null {
  const cls = input.optimizationClass;
  if (!cls || !(OPTIMIZATION_CLASSES as readonly string[]).includes(cls)) {
    return null;
  }

  const event =
    input.conversionEvent &&
    (CONVERSION_EVENTS as readonly string[]).includes(input.conversionEvent)
      ? (input.conversionEvent as ConversionEvent)
      : null;

  if (cls !== 'CONVERSION') {
    return nonConversionTarget(cls as Exclude<OptimizationClass, 'CONVERSION'>);
  }

  return {
    optimizationClass: 'CONVERSION',
    conversionEvent: event,
    // Sem evento identificado não há o que contar: a flag da coluna não basta.
    conversionMeasurable: event !== null && input.conversionMeasurable === true,
  };
}

/**
 * O objetivo do anúncio: o do conjunto, e o da campanha quando o conjunto não
 * o declara.
 *
 * O conjunto vem primeiro porque é onde Meta e TikTok decidem a otimização; a
 * campanha é o objetivo amplo. No Google a otimização é da campanha, e o
 * provider replica o valor dela no grupo — o resultado é o mesmo pelos dois
 * caminhos.
 */
export function resolveAdOptimization(
  adSet: OptimizationTarget | null,
  campaign: OptimizationTarget | null,
): ResolvedOptimization {
  if (adSet && adSet.optimizationClass !== 'UNKNOWN') {
    return { ...adSet, source: 'AD_SET' };
  }
  if (campaign && campaign.optimizationClass !== 'UNKNOWN') {
    return { ...campaign, source: 'CAMPAIGN' };
  }
  return { ...UNKNOWN_OPTIMIZATION, source: 'NONE' };
}

/**
 * Pode-se julgar este anúncio por conversão?
 *
 * É a única pergunta que os detectores de conversão, o `audienceFit` e a
 * guarda de escala fazem. `UNKNOWN` responde **não**: sem saber o objetivo, a
 * resposta segura é não cobrar conversão — a alternativa é o falso positivo
 * que motivou este arquivo.
 */
export function judgesConversion(target: OptimizationTarget): boolean {
  return (
    target.optimizationClass === 'CONVERSION' && target.conversionMeasurable
  );
}

/**
 * A chave de comparação entre anúncios da mesma conta.
 *
 * Mediana de CPA só compara quem conta a mesma coisa como conversão, e mediana
 * de CTR só compara quem busca o mesmo resultado: o CTR de um anúncio de alcance
 * não é régua para o de um anúncio de venda.
 */
export function benchmarkSegmentOf(target: OptimizationTarget): string {
  return target.optimizationClass === 'CONVERSION'
    ? `CONVERSION:${target.conversionEvent ?? 'UNKNOWN'}`
    : target.optimizationClass;
}

const CLASS_LABELS: Record<OptimizationClass, string> = {
  CONVERSION: 'conversão',
  TRAFFIC: 'tráfego',
  AWARENESS: 'alcance e reconhecimento',
  ENGAGEMENT: 'engajamento',
  UNKNOWN: 'objetivo não identificado',
};

const EVENT_LABELS: Record<ConversionEvent, string> = {
  PURCHASE: 'compra',
  LEAD: 'lead',
  COMPLETE_REGISTRATION: 'cadastro',
  ADD_TO_CART: 'adição ao carrinho',
  INITIATED_CHECKOUT: 'início de checkout',
  ADD_PAYMENT_INFO: 'dados de pagamento',
  ADD_TO_WISHLIST: 'lista de desejos',
  CONTENT_VIEW: 'visualização de conteúdo',
  SEARCH: 'busca',
  CONTACT: 'contato',
  SCHEDULE: 'agendamento',
  START_TRIAL: 'início de teste',
  SUBMIT_APPLICATION: 'envio de inscrição',
  SUBSCRIBE: 'assinatura',
  DONATE: 'doação',
  FIND_LOCATION: 'busca de localização',
  CUSTOMIZE_PRODUCT: 'personalização de produto',
  APP_INSTALL: 'instalação de app',
  APP_EVENT: 'evento no app',
  MESSAGING_CONVERSATION: 'conversa por mensagem',
  CALL: 'ligação',
  CUSTOM_CONVERSION: 'conversão personalizada',
  MULTIPLE: 'várias metas de conversão',
  OTHER: 'outro evento de conversão',
};

export function optimizationClassLabel(cls: OptimizationClass): string {
  return CLASS_LABELS[cls];
}

export function conversionEventLabel(event: ConversionEvent): string {
  return EVENT_LABELS[event];
}

/** "conversão (lead)", "tráfego" — a forma que vai para a tela. */
export function describeOptimization(target: OptimizationTarget): string {
  if (target.optimizationClass === 'CONVERSION' && target.conversionEvent) {
    return `${CLASS_LABELS.CONVERSION} (${EVENT_LABELS[target.conversionEvent]})`;
  }
  return CLASS_LABELS[target.optimizationClass];
}
