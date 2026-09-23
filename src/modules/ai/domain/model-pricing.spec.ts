import {
  costBaseOf,
  estimatedCallCostBase,
  MODEL_PRICES_USD,
  type PricingContext,
} from './model-pricing';

const BRL: PricingContext = {
  baseCurrency: 'BRL',
  pricingBaseCurrency: 'BRL',
  usdToBase: 5.5,
};

const call = (model: string, context: PricingContext = BRL) =>
  costBaseOf({
    provider: 'openai',
    model,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    context,
  });

describe('costBaseOf', () => {
  it('prices a listed model from the table', () => {
    // 0,20 + 1,20 = US$ 1,40 por milhão de cada, a 5,5.
    expect(call('gpt-5.6-luna')).toEqual({
      costBase: 7.7,
      // A taxa que produziu o número vem junto: sem ela, o custo histórico não
      // diz se usou 5,5 ou 6,2, e atualizar a env reescreveria o passado.
      usdToBaseRate: 5.5,
      basis: 'LISTED',
    });
  });

  it('charges an unlisted model at the most expensive known price', () => {
    const verdict = call('modelo-que-nao-existe');

    // Nunca `null` e nunca zero: fallback só roda em incidente, e é aí que a
    // contabilidade não pode ficar cega. Superestimar deixa o teto conservador;
    // subestimar deixa gastar sem limite.
    expect(verdict.basis).toBe('MOST_EXPENSIVE_KNOWN');
    expect(verdict.costBase).toBe(call('claude-sonnet-5').costBase);
  });

  it('never prices below what a known model would have cost', () => {
    const unlisted = call('modelo-que-nao-existe').costBase as number;

    for (const model of Object.keys(MODEL_PRICES_USD)) {
      expect(unlisted).toBeGreaterThanOrEqual(call(model).costBase as number);
    }
  });

  it('refuses to price into a base currency it cannot convert to', () => {
    // Gravar reais num campo que significa "moeda-base desta organização" seria
    // um erro silencioso de 5,5x no dado que alimenta cobrança e teto.
    expect(call('gpt-5.6-luna', { ...BRL, baseCurrency: 'EUR' })).toEqual({
      costBase: null,
      // Nada foi convertido: carimbar a taxa corrente afirmaria um câmbio que
      // não aconteceu.
      usdToBaseRate: null,
      basis: 'CURRENCY_NOT_CONVERTIBLE',
    });
  });

  it('prices a USD organisation with no exchange rate at all', () => {
    // A tabela já está em dólar: taxa 1, sem depender do ambiente.
    expect(call('gpt-5.6-luna', { ...BRL, baseCurrency: 'USD' })).toEqual({
      costBase: 1.4,
      // Organização em dólar: a taxa é 1, e é ela que fica registrada.
      usdToBaseRate: 1,
      basis: 'LISTED',
    });
  });

  it('reports zero for the memory fallback, in any currency', () => {
    // Não chamou LLM: zero é medição, não ausência — e zero é zero em qualquer
    // moeda, então a guarda de conversão não se aplica.
    expect(
      costBaseOf({
        provider: 'memory',
        model: 'memory-fallback',
        inputTokens: 0,
        outputTokens: 0,
        context: { ...BRL, baseCurrency: 'EUR' },
      }),
      // Zero é medição, não conversão: o fallback em memória não chamou LLM
      // nenhum, então não há taxa a carimbar.
    ).toEqual({ costBase: 0, usdToBaseRate: null, basis: 'LISTED' });
  });

  it('separates "not measured" from "free"', () => {
    expect(
      costBaseOf({
        provider: 'openai',
        model: 'gpt-5.6-luna',
        inputTokens: null,
        outputTokens: null,
        context: BRL,
      }),
    ).toEqual({ costBase: null, usdToBaseRate: null, basis: 'NOT_MEASURED' });
  });
});

describe('estimatedCallCostBase', () => {
  it('assumes the most expensive model, because the route is not known yet', () => {
    const estimate = estimatedCallCostBase(BRL) as number;

    const cheapest = costBaseOf({
      provider: 'openai',
      model: 'gpt-5.6-luna',
      inputTokens: 382,
      outputTokens: 198,
      context: BRL,
    }).costBase as number;

    expect(estimate).toBeGreaterThan(cheapest);
  });

  it('is null when the base currency cannot be priced', () => {
    expect(estimatedCallCostBase({ ...BRL, baseCurrency: 'EUR' })).toBeNull();
  });
});
