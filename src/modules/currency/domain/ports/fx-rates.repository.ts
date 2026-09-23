import { FxRate } from '../fx-rate';

export type FxRateRangeQuery = {
  /** Moedas de destino desejadas; o lado de origem é sempre o pivô. */
  currencies: string[];
  since: Date;
  until: Date;
};

/**
 * **O único acesso a `fx_rates` em todo o `src/`** (§16.10).
 *
 * A regra é verificável por `grep -rn "fx_rates" src/ | grep -v modules/currency`,
 * e existe porque conversão espalhada é como o mesmo gasto passa a ter dois
 * valores na mesma tela: cada módulo escolhe a taxa de um dia ligeiramente
 * diferente e nenhum está obviamente errado.
 */
export abstract class FxRatesRepositoryInterface {
  /** Taxas do pivô para as moedas pedidas dentro da janela, em ordem de data. */
  abstract findRange(query: FxRateRangeQuery): Promise<FxRate[]>;

  /** Insere ignorando duplicata por `(date, from, to, source)`. Devolve quantas entraram. */
  abstract saveMany(rates: FxRate[]): Promise<number>;

  /** Data da cotação mais recente já coletada para a moeda, ou `null`. */
  abstract latestDateFor(currency: string): Promise<Date | null>;

  /** Quantos dias distintos de cotação existem — insumo do gate G9. */
  abstract countDistinctDates(currency: string): Promise<number>;
}
