import { FxRate, ResolvedRate } from './fx-rate';

/**
 * Casas decimais do dinheiro persistido. Casa com `Decimal(14, 4)` no schema:
 * arredondar aqui com outra precisão faria a soma do banco divergir da soma da
 * aplicação nas casas que ninguém olha — até o total da tela não fechar.
 */
export const MONEY_SCALE = 4;

/**
 * Toda a matemática monetária da plataforma, **pura** (§5.2).
 *
 * Sem I/O, sem `Date.now()`, sem Prisma: recebe as taxas já lidas e devolve o
 * número. É essa pureza que permite testar M1–M4 nas fronteiras sem banco, e é
 * ela que faz do módulo `currency` um dono de verdade — as regras não viram
 * disciplina espalhada por cada módulo que multiplica dois números.
 *
 * | Regra | O que impõe |
 * |---|---|
 * | **M1** | a inteligência lê só o normalizado; limiares são declarados em moeda-base |
 * | **M2** | a taxa é fixada na ingestão e nunca recalculada — por isso `resolve` devolve `asOf` e `source` para gravar na linha |
 * | **M3** | parâmetro de ação vai na moeda da **conta**; converter aqui seria mover dinheiro na quantia errada |
 * | **M4** | a medição de impacto usa a mesma taxa nas duas janelas, a de `appliedAt` |
 */
export class CurrencyNormalizationService {
  constructor(private readonly pivotCurrency: string) {}

  /**
   * Resolve a taxa `from → to` na data pedida, a partir de um conjunto de taxas
   * contra o pivô.
   *
   * Três caminhos, nesta ordem:
   *
   * 1. **Mesma moeda** — taxa 1, sem consultar nada. Uma conta em BRL numa
   *    organização em BRL não pode depender de o vendor ter respondido hoje.
   * 2. **Taxa direta** contra o pivô, quando um dos lados é o próprio pivô.
   * 3. **Taxa cruzada**: `from → pivô → to`.
   *
   * Devolve `null` quando falta insumo. O chamador então grava
   * `normalizationPending = true` e segue: **taxa indisponível nunca bloqueia a
   * ingestão** — perder o dado do dia é pior que perder a comparabilidade dele.
   */
  resolve(
    fromCurrency: string,
    toCurrency: string,
    date: Date,
    rates: FxRate[],
  ): ResolvedRate | null {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) {
      return { rate: 1, asOf: date, source: 'identity', carriedForward: false };
    }

    const pivot = this.pivotCurrency.toUpperCase();

    if (from === pivot) return this.pivotRate(to, date, rates);
    if (to === pivot) {
      const inverse = this.pivotRate(from, date, rates);
      if (!inverse || inverse.rate === 0) return null;
      return { ...inverse, rate: 1 / inverse.rate };
    }

    const fromPivot = this.pivotRate(from, date, rates);
    const toPivot = this.pivotRate(to, date, rates);
    if (!fromPivot || !toPivot || fromPivot.rate === 0) return null;

    return {
      // pivô→to dividido por pivô→from: quantas unidades de `to` valem uma de `from`.
      rate: toPivot.rate / fromPivot.rate,
      // A data mais ANTIGA das duas: é até onde a evidência de fato alcança.
      asOf: fromPivot.asOf < toPivot.asOf ? fromPivot.asOf : toPivot.asOf,
      source:
        fromPivot.carriedForward || toPivot.carriedForward
          ? `${toPivot.source}:cross:carry-forward`
          : `${toPivot.source}:cross`,
      carriedForward: fromPivot.carriedForward || toPivot.carriedForward,
    };
  }

  /** Converte e arredonda. `null` quando a taxa não pôde ser resolvida. */
  convert(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
    date: Date,
    rates: FxRate[],
  ): { amount: number; rate: ResolvedRate } | null {
    const rate = this.resolve(fromCurrency, toCurrency, date, rates);
    if (!rate) return null;

    return { amount: round(amount * rate.rate), rate };
  }

  /**
   * Taxa `pivô → currency` na data, com carry-forward **só para trás** (D19).
   *
   * Fim de semana e feriado não têm cotação, e o dado de mídia tem. Arrastar a
   * última taxa conhecida para frente é a convenção do mercado; usar uma taxa
   * futura para uma data passada seria extrapolação — reescreveria o passado com
   * informação que não existia nele, que é exatamente o que M2 proíbe.
   */
  private pivotRate(
    currency: string,
    date: Date,
    rates: FxRate[],
  ): ResolvedRate | null {
    const pivot = this.pivotCurrency.toUpperCase();
    const target = startOfUtcDay(date).getTime();

    const candidates = rates
      .filter(
        (candidate) =>
          candidate.fromCurrency.toUpperCase() === pivot &&
          candidate.toCurrency.toUpperCase() === currency &&
          startOfUtcDay(candidate.date).getTime() <= target,
      )
      .sort(
        (a, b) =>
          startOfUtcDay(b.date).getTime() - startOfUtcDay(a.date).getTime(),
      );

    const best = candidates[0];
    if (!best) return null;

    const carriedForward = startOfUtcDay(best.date).getTime() !== target;

    return {
      rate: best.rate,
      asOf: startOfUtcDay(best.date),
      source: carriedForward ? `${best.source}:carry-forward` : best.source,
      carriedForward,
    };
  }
}

/**
 * Arredondamento half-up em 4 casas, feito sobre inteiro para não herdar o erro
 * de ponto flutuante: `Math.round(1.005 * 100) / 100` devolve 1 em vez de 1,01.
 */
export function round(value: number, scale: number = MONEY_SCALE): number {
  const factor = 10 ** scale;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
