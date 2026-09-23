import { buildBaseline } from './baseline';
import type {
  AdWindowAggregate,
  Baseline,
  Percentiles,
} from './detection-context';
import type { ScopeLevel } from './contracts/finding-catalog';

/**
 * A queda para linha de base da conta, **declarada e não silenciosa** (DEC-3).
 *
 * | Pares no ad set | Benchmark | `scopeLevel` | Limiar | `evidenceSufficiency` |
 * |---|---|---|---|---|
 * | ≥ 3 | mediana do ad set | `AD_SET` | nominal | `SUFFICIENT` |
 * | < 3 | mediana da conta | `AD_ACCOUNT` | **1,5× o nominal** | `PARTIAL` |
 * | conta com < 3 ads | — | — | **não dispara** | `INSUFFICIENT` |
 *
 * A alternativa — exigir 3 pares como condição de disparo — silenciaria contas
 * inteiras: um anúncio por ad set é a estrutura mais comum em contas pequenas,
 * exatamente onde desperdício dói mais. O preço da imprecisão é o limiar mais
 * conservador, e o rótulo `PARTIAL` faz a recomendação derivada herdar a
 * confiança reduzida em vez de fingir que ela não caiu.
 */

/** O mínimo de §10.3, dos dois lados: pares no conjunto e ads na conta. */
export const MIN_BENCHMARK_SAMPLE = 3;

/**
 * Onde moram os pares, na frase do diagnóstico. A unidade sem conjunto — o
 * grupo de recursos do Performance Max — compara-se com os da mesma campanha
 * (`peerGroupKeyOf`), e dizer "pares do conjunto" sobre ela seria descrever uma
 * comparação que não aconteceu.
 */
export function peerScopeOf(ad: Pick<AdWindowAggregate, 'adSetId'>): {
  of: string;
  in: string;
  same: string;
} {
  return ad.adSetId
    ? { of: 'do conjunto', in: 'no conjunto', same: 'no mesmo conjunto' }
    : { of: 'da campanha', in: 'na campanha', same: 'na mesma campanha' };
}

export type BenchmarkMetric = 'cpa' | 'ctr' | 'roas' | 'impressions';

/**
 * De que lado do limiar mora o problema.
 *
 * Existe porque "1,5× o nominal" não é multiplicação em todo caso: `HIGH_CPA`
 * dispara **acima** do corte e ficar conservador é subir o corte; `LOW_CTR`
 * dispara **abaixo** e ficar conservador é baixá-lo. Multiplicar os dois faria o
 * fallback de `LOW_CTR` ficar 50% mais **agressivo** — o oposto exato do que
 * DEC-3 decidiu.
 */
export type ThresholdDirection = 'ABOVE' | 'BELOW';

export type Benchmark = {
  kind: 'AD_SET_PEERS' | 'ACCOUNT_BASELINE';
  scopeLevel: ScopeLevel;
  sufficiency: 'SUFFICIENT' | 'PARTIAL';
  /** Tamanho da amostra que sustenta a comparação. */
  pairs: number;
  percentiles: Percentiles;
  /** 1 no caminho nominal; o multiplicador de DEC-3 na queda. */
  multiplier: number;
};

/**
 * Escolhe o benchmark, ou devolve `null` quando não há nenhum defensável.
 *
 * `null` é o terceiro caso da tabela: conta com menos de 3 anúncios não tem
 * linha de base, e inventar uma a partir de dois anúncios produziria um limiar
 * que é apenas o outro anúncio com outro nome.
 */
export function selectBenchmark(input: {
  peers: AdWindowAggregate[];
  accountBaseline: Baseline;
  metric: BenchmarkMetric;
  fallbackMultiplier: number;
}): Benchmark | null {
  if (input.peers.length >= MIN_BENCHMARK_SAMPLE) {
    return {
      kind: 'AD_SET_PEERS',
      scopeLevel: 'AD_SET',
      sufficiency: 'SUFFICIENT',
      pairs: input.peers.length,
      percentiles: buildBaseline(input.peers)[input.metric],
      multiplier: 1,
    };
  }

  if (input.accountBaseline.sampleSize < MIN_BENCHMARK_SAMPLE) return null;

  return {
    kind: 'ACCOUNT_BASELINE',
    scopeLevel: 'AD_ACCOUNT',
    sufficiency: 'PARTIAL',
    pairs: input.accountBaseline.sampleSize,
    percentiles: input.accountBaseline[input.metric],
    multiplier: input.fallbackMultiplier,
  };
}

/**
 * Aplica o multiplicador de DEC-3 **na direção certa**.
 *
 * `ABOVE`: o corte sobe (2× a mediana vira 3×). `BELOW`: o corte desce (p25 vira
 * p25/1,5). Nos dois casos o efeito é o mesmo — disparar menos, porque o
 * benchmark é de outro público.
 */
export function conservativeThreshold(
  threshold: number,
  direction: ThresholdDirection,
  multiplier: number,
): number {
  if (multiplier === 1) return threshold;
  return direction === 'ABOVE'
    ? threshold * multiplier
    : threshold / multiplier;
}
