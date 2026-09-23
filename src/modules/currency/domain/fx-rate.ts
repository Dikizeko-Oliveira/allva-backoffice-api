/**
 * Uma taxa de câmbio observada num dia, contra o pivô.
 *
 * Toda coleta é feita **contra `FX_PIVOT_CURRENCY`** (padrão `USD`) e qualquer
 * par sai por taxa cruzada. Coletar par a par explodiria em N² chamadas e faria
 * `BRL→EUR` e `EUR→BRL` divergirem por arredondamento — o mesmo dinheiro com
 * dois valores dependendo da direção da leitura.
 */
export type FxRate = {
  /** Data a que a taxa se refere, em UTC e truncada no dia. */
  date: Date;
  fromCurrency: string;
  toCurrency: string;
  /** Quantas unidades de `toCurrency` valem 1 de `fromCurrency`. */
  rate: number;
  source: string;
};

/** O resultado de resolver a taxa de um par numa data. */
export type ResolvedRate = {
  rate: number;
  /** A data da taxa **usada** — não a pedida, quando houve carry-forward. */
  asOf: Date;
  /**
   * `source` do vendor, com sufixo quando a taxa não é do dia pedido. M2 exige
   * que a linha registre de onde veio o número; sem o sufixo, um valor
   * carregado de sexta para domingo seria indistinguível de uma cotação real de
   * domingo.
   */
  source: string;
  /** Taxa de um dia anterior, arrastada para frente por ausência de cotação. */
  carriedForward: boolean;
};
