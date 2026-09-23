import { FxRate } from '../fx-rate';

/**
 * O provedor externo de câmbio (D19).
 *
 * **Exige histórico por data, não só taxa spot.** Um provedor que só responde
 * "quanto vale hoje" torna M2 inaplicável: o primeiro ingest lê 14+ dias para
 * trás e precisa da taxa **da data de cada linha**; com spot, o histórico
 * inteiro entraria com `normalizationPending = true` e ficaria fora de toda
 * agregação de inteligência — o produto nasceria sem número.
 */
export abstract class FxRateProviderInterface {
  /** Identificador gravado em `fx_rates.source` e em cada linha monetária. */
  abstract readonly source: string;

  /** `false` quando falta credencial: o job registra a degradação e não tenta. */
  abstract isConfigured(): boolean;

  /**
   * Taxas do pivô para `currencies` em cada dia do intervalo, inclusive.
   * O provedor devolve o que tem — dias sem cotação (fim de semana, feriado)
   * simplesmente não vêm, e o carry-forward do domínio cuida deles.
   */
  abstract getHistorical(input: {
    pivotCurrency: string;
    currencies: string[];
    since: Date;
    until: Date;
  }): Promise<FxRate[]>;
}
