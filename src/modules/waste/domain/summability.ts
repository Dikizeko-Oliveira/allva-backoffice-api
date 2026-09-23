import { FINDING_KIND } from './contracts/finding-catalog';
import type { FindingType } from './contracts/finding-catalog';

/**
 * §10.6 — a tabela de somabilidade, como código.
 *
 * | Grandeza | Regra |
 * |---|---|
 * | `incurredAmount` entre tipos, no mesmo anúncio | **não soma** — o `max` |
 * | `incurredAmount` entre anúncios | soma — disjuntos por construção |
 * | `avoidableDailyAmount` entre tipos, no mesmo anúncio | **não soma** — o `max` |
 * | `findingKind = OPPORTUNITY` | **nunca** entra em total de desperdício |
 *
 * O `max` entre tipos não é aproximação: um anúncio com `ZERO_CONVERSIONS` e
 * `LOW_CTR` desperdiçou **um** gasto, não dois. Somar os dois contaria o mesmo
 * dinheiro duas vezes no eixo do tipo — o Apêndice A nº 2 com outra roupa —, e
 * pausar o anúncio resolve os dois de uma vez, que é por que o evitável também é
 * o máximo e não a soma.
 */

export type SummableFinding = {
  type: FindingType;
  incurred: { value: number; valueBase: number };
  avoidableDaily: { value: number; valueBase: number };
};

export type AdWasteRollup = {
  /** Só achados `WASTE`: oportunidade não é desperdício aberto. */
  openWasteCount: number;
  incurred: { value: number; valueBase: number };
  avoidableDaily: { value: number; valueBase: number };
};

/**
 * O que as colunas denormalizadas de `ads` recebem (§5.4, grupo do `waste`).
 *
 * São essas colunas — e somente elas — que os rollups somam. `waste_items.amount`
 * nunca é somado por rollup nenhum, porque somaria entre tipos.
 */
export function rollupForAd(findings: SummableFinding[]): AdWasteRollup {
  const waste = findings.filter(
    (finding) => FINDING_KIND[finding.type] === 'WASTE',
  );

  return {
    openWasteCount: waste.length,
    incurred: {
      value: maxOf(waste.map((finding) => finding.incurred.value)),
      valueBase: maxOf(waste.map((finding) => finding.incurred.valueBase)),
    },
    avoidableDaily: {
      value: maxOf(waste.map((finding) => finding.avoidableDaily.value)),
      valueBase: maxOf(
        waste.map((finding) => finding.avoidableDaily.valueBase),
      ),
    },
  };
}

function maxOf(values: number[]): number {
  return values.reduce((max, value) => (value > max ? value : max), 0);
}
