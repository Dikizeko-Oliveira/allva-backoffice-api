/**
 * A forma monetária, **no domínio** (§7.0.2, R-M).
 *
 * Vive aqui e não em `infrastructure/http` porque os read models do domínio a
 * usam, e domínio não importa infraestrutura (§16.6). O envelope HTTP a
 * reexporta: uma definição só, na camada que pode ser importada por todas as
 * outras.
 *
 * Original **e** normalizado juntos, com a taxa e a data que fizeram a
 * conversão. Expor só um dos dois obriga o cliente a converter — e converter no
 * cliente é como a v1 produzia dois números diferentes para o mesmo gasto na
 * mesma tela.
 */
export type MoneyView = {
  value: number;
  currency: string;
  valueBase: number;
  baseCurrency: string;
  /**
   * Ausentes em dois casos legítimos: conta na própria moeda-base (taxa 1) e
   * linha com `normalizationPending` (M1). No segundo, `valueBase` é estimativa
   * declarada, não fato — e a ausência da taxa é como o consumidor distingue.
   */
  fxRate?: number;
  /** `YYYY-MM-DD` — a data da linha, nunca a de hoje (M2). */
  fxAsOf?: string;
};

export type MoneyViewInput = {
  value: number;
  currency: string;
  valueBase: number;
  baseCurrency: string;
  fxRate?: number | null;
  fxAsOf?: string | Date | null;
};

/**
 * Monta um `MoneyView`. **Não converte nada** — conversão, arredondamento e
 * leitura da tabela de câmbio pertencem ao módulo `currency` (§5.2, §16.10).
 */
export function moneyView(input: MoneyViewInput): MoneyView {
  const view: MoneyView = {
    value: input.value,
    currency: input.currency,
    valueBase: input.valueBase,
    baseCurrency: input.baseCurrency,
  };

  if (input.fxRate != null) view.fxRate = input.fxRate;
  if (input.fxAsOf != null) {
    view.fxAsOf =
      input.fxAsOf instanceof Date
        ? input.fxAsOf.toISOString().slice(0, 10)
        : input.fxAsOf;
  }

  return view;
}

/**
 * Moedas cujo expoente ISO 4217 **não** é 2.
 *
 * As plataformas de anúncio trocam valor monetário em unidade menor: a Meta
 * devolve `daily_budget: "5000"` e espera o mesmo formato de volta. Dividir por
 * 100 sempre — que é o que o produto fazia — erra em toda conta que não usa
 * duas casas, e erra na direção cara: um orçamento de ¥50.000 lido como ¥500 é
 * um número errado na tela, mas **escrito** de volta como 5.000.000 é cem vezes
 * o gasto pretendido, aprovado por um usuário que viu outro número.
 *
 * A lista é fechada porque ISO 4217 é fechado; o default de 2 casas cobre o
 * resto sem precisar enumerá-lo.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

/** Quantas casas decimais a moeda tem — o expoente ISO 4217. */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();

  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Valor em unidade maior → unidade menor, como a plataforma espera.
 *
 * `Math.round` e não `Math.trunc`: truncar 49,999999 — que é o que a aritmética
 * de ponto flutuante produz para 50 — mandaria 4999 em vez de 5000, e o
 * orçamento sairia um centavo menor a cada escrita.
 */
export function toMinorUnits(amount: number, currency: string): string {
  const factor = 10 ** currencyExponent(currency);
  return String(Math.round(amount * factor));
}

/** Unidade menor → unidade maior. Aceita a string que a plataforma devolve. */
export function fromMinorUnits(
  minor: string | number | null | undefined,
  currency: string,
): number | null {
  if (minor === null || minor === undefined || minor === '') return null;

  const parsed = typeof minor === 'number' ? minor : Number(minor);
  if (!Number.isFinite(parsed)) return null;

  return parsed / 10 ** currencyExponent(currency);
}
