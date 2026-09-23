/**
 * Quanto custa uma chamada, por modelo.
 *
 * A tabela é declarada **em dólar**, que é como os fornecedores publicam, e a
 * conversão para moeda-base acontece na borda, com a taxa que o ambiente
 * declara. Guardar já convertido esconderia duas decisões — o preço e a taxa —
 * num número só, e só uma delas muda quando o fornecedor mexe no preço.
 *
 * Por que não passa pelo módulo `currency`: ele existe para dinheiro de
 * plataforma, onde a **data** do câmbio é a peça central — converter na leitura
 * faria o desperdício histórico variar todo dia sem nada ter acontecido (M2).
 * Custo de IA é fatura de fornecedor na moeda do contrato, sem passado a
 * reescrever. E na prática, sem `fx_rates` populado, amarrá-lo lá deixaria o
 * custo sempre nulo e o teto diário inerte.
 */
export type ModelPriceUsd = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

/**
 * Preço de tabela dos quatro modelos da rota.
 *
 * O `cached input` do `gpt-5.4-mini` (US$ 0,075) **não** é modelado: o cache
 * automático da OpenAI só vale a partir de ~1024 tokens de entrada, e uma
 * narrativa mede ~250. Seria um desconto que nunca acontece, e um número que
 * nunca acontece é pior que a ausência dele — ele faria a projeção de custo
 * parecer melhor do que a fatura.
 */
export const MODEL_PRICES_USD: Readonly<Record<string, ModelPriceUsd>> = {
  'gpt-5.6-luna': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
  'gpt-5.4-mini': { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  'claude-sonnet-5': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0 },
  'claude-haiku-4-5': { inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0 },
};

/**
 * O desfecho do cálculo, com o **motivo** junto.
 *
 * Devolver só `number | null` obrigaria quem chama a adivinhar por que o custo
 * faltou — e "modelo sem preço" e "moeda não conversível" pedem providências
 * diferentes de quem lê o log.
 */
/**
 * A taxa que **de fato** produziu o número, devolvida junto dele.
 *
 * Vai no veredito, e não é relida por quem grava, porque uma segunda leitura
 * pode discordar: a moeda-base da organização ou a env podem mudar entre a
 * conversão e a gravação, e o log passaria a afirmar uma taxa que não foi usada.
 * Aqui a origem é uma só.
 *
 * `null` sempre que nada foi convertido: as duas formas sem custo, e o fallback
 * em memória, cujo zero é medição e não resultado de conversão. Inventar a taxa
 * corrente nesses casos afirmaria um câmbio que não aconteceu.
 */
export type CostVerdict =
  /** Preço listado para este modelo. */
  | { costBase: number; usdToBaseRate: number | null; basis: 'LISTED' }
  /**
   * Modelo fora da tabela, cobrado pelo **mais caro** que conhecemos.
   *
   * A primeira redação devolvia `null` aqui, com o argumento de que zero
   * mentiria para o teto. O argumento estava certo sobre o log e errado sobre o
   * orçamento: `spentTodayBase` soma `cost_base`, e `null` contribui zero
   * exatamente como zero contribuiria — as duas opções eram igualmente cegas.
   *
   * Modelos fora da tabela são os fallbacks, e fallback só roda em incidente:
   * é precisamente quando não se quer a contabilidade cega. Superestimar apenas
   * deixa o teto conservador — há folga de 7,5× no teto do plano —, enquanto
   * subestimar deixa gastar sem limite. O `basis` é o que impede a aproximação
   * de virar permanente e invisível.
   */
  | {
      costBase: number;
      usdToBaseRate: number;
      basis: 'MOST_EXPENSIVE_KNOWN';
    }
  /**
   * A moeda-base da organização não é a da tabela e não sabemos converter.
   *
   * **Aqui `null` é a resposta certa**: gravar reais num campo que significa
   * "moeda-base desta organização" seria um erro silencioso de 5,5× no dado que
   * alimenta cobrança e teto de gasto. Declarar a lacuna é melhor que emitir um
   * número errado com cara de certo.
   */
  | { costBase: null; usdToBaseRate: null; basis: 'CURRENCY_NOT_CONVERTIBLE' }
  /** O provider não informou uso — não há o que calcular. */
  | { costBase: null; usdToBaseRate: null; basis: 'NOT_MEASURED' };

export type PricingContext = {
  /** Moeda-base da organização que vai receber o lançamento. */
  baseCurrency: string;
  /** Moeda em que `AI_USD_TO_BASE_RATE` converte. */
  pricingBaseCurrency: string;
  usdToBase: number;
};

/**
 * A taxa aplicável, ou `null` quando não sabemos converter.
 *
 * Organização com base em dólar é o caso fácil e sai de graça: a tabela já está
 * em dólar, então a taxa é 1 — não depende do ambiente nem de câmbio.
 */
function rateFor(context: PricingContext): number | null {
  const base = context.baseCurrency.toUpperCase();

  if (base === 'USD') return 1;
  if (base === context.pricingBaseCurrency.toUpperCase()) {
    return context.usdToBase;
  }

  return null;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function costOf(
  price: ModelPriceUsd,
  inputTokens: number,
  outputTokens: number,
  rate: number,
): number {
  return round6(
    ((inputTokens / 1_000_000) * price.inputPerMillionUsd +
      (outputTokens / 1_000_000) * price.outputPerMillionUsd) *
      rate,
  );
}

/** O mais caro da tabela sobre este uso — o piso de segurança do orçamento. */
function mostExpensive(
  inputTokens: number,
  outputTokens: number,
  rate: number,
): number {
  return Math.max(
    ...Object.values(MODEL_PRICES_USD).map((price) =>
      costOf(price, inputTokens, outputTokens, rate),
    ),
  );
}

export function costBaseOf(input: {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  context: PricingContext;
}): CostVerdict {
  // Fallback em memória não chama LLM: zero é medição, não ausência — e vale
  // antes da guarda de moeda, porque zero é zero em qualquer moeda.
  if (input.provider === 'memory') {
    /**
     * `LISTED` com taxa nula, e é o único caso em que as duas convivem: o
     * fallback em memória não chamou LLM, então o zero é medição e não houve
     * conversão a registrar. Carimbar a taxa corrente aqui afirmaria uma
     * conversão que não aconteceu.
     */
    return { costBase: 0, usdToBaseRate: null, basis: 'LISTED' };
  }

  if (input.inputTokens === null || input.outputTokens === null) {
    return { costBase: null, usdToBaseRate: null, basis: 'NOT_MEASURED' };
  }

  const rate = rateFor(input.context);
  if (rate === null) {
    return {
      costBase: null,
      usdToBaseRate: null,
      basis: 'CURRENCY_NOT_CONVERTIBLE',
    };
  }

  const price = MODEL_PRICES_USD[input.model];

  if (!price) {
    return {
      costBase: mostExpensive(input.inputTokens, input.outputTokens, rate),
      usdToBaseRate: rate,
      basis: 'MOST_EXPENSIVE_KNOWN',
    };
  }

  return {
    costBase: costOf(price, input.inputTokens, input.outputTokens, rate),
    usdToBaseRate: rate,
    basis: 'LISTED',
  };
}

/**
 * Perfil típico de uma narrativa, **medido** e não estimado.
 *
 * Médias de execuções reais de `AD_NARRATIVE`. A primeira estimativa a olho foi
 * 295/107 e errou para menos nos dois lados — de onde a regra: este número se
 * corrige contra `AIDecisionLog`, que grava tokens de verdade, e não contra a
 * intuição de quem escreve o prompt.
 */
const TYPICAL_NARRATIVE_TOKENS = { input: 382, output: 198 };

/**
 * Quanto assumir que a próxima chamada vai custar, **antes** de fazê-la.
 *
 * `evaluateBudget` soma esta estimativa ao gasto do dia para decidir se corta —
 * a decisão precisa acontecer antes de gastar, e antes ninguém sabe qual
 * candidato da rota vai atender. Assume-se o mais caro da tabela: subestimar
 * aqui deixa passar justamente a chamada que estoura o teto.
 *
 * Sem taxa aplicável devolve `null`, e `evaluateBudget` trata teto nulo como
 * "sem limite declarado" — coerente com não sabermos afirmar o custo.
 */
export function estimatedCallCostBase(context: PricingContext): number | null {
  const rate = rateFor(context);
  if (rate === null) return null;

  return mostExpensive(
    TYPICAL_NARRATIVE_TOKENS.input,
    TYPICAL_NARRATIVE_TOKENS.output,
    rate,
  );
}
