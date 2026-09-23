import { at, evaluateGate } from '../evidence';
import {
  MIN_BENCHMARK_SAMPLE,
  peerScopeOf,
  selectBenchmark,
} from '../benchmark';
import type {
  AdScopedDetector,
  AdSetDetectionContext,
  AdSetScopedDetector,
  DetectionContext,
  DetectionOutcome,
} from '../detection-context';
import {
  audienceSaturationDetector,
  overlappingDeliveryDetector,
} from './ad-set.detectors';
import {
  creativeFatigueDetector,
  learningInstabilityDetector,
  lowCtrDetector,
  negativeFeedbackDetector,
} from './engagement.detectors';
import { budgetStarvationDetector } from './opportunity.detectors';
import {
  highCpaDetector,
  lowRoasDetector,
  zeroConversionsDetector,
} from './spend-efficiency.detectors';

/**
 * O registro dos dez detectores, e o **portão que nenhum deles aplica**.
 *
 * A evidência mínima é verificada aqui, fora dos detectores, e a escolha é
 * deliberada: dentro de cada um seriam dez cópias da mesma regra, e a décima
 * primeira nasceria sem ela. Com o portão no runner, um detector novo não tem
 * como esquecê-lo — e o teste percorre este array, então acrescentar um tipo
 * sem limiar no perfil quebra na hora.
 */

export const AD_SCOPED_DETECTORS: readonly AdScopedDetector[] = [
  zeroConversionsDetector,
  lowRoasDetector,
  highCpaDetector,
  lowCtrDetector,
  creativeFatigueDetector,
  negativeFeedbackDetector,
  learningInstabilityDetector,
  budgetStarvationDetector,
];

export const AD_SET_SCOPED_DETECTORS: readonly AdSetScopedDetector[] = [
  audienceSaturationDetector,
  overlappingDeliveryDetector,
];

export const ALL_DETECTORS = [
  ...AD_SCOPED_DETECTORS,
  ...AD_SET_SCOPED_DETECTORS,
];

export function detectorVersionOf(type: string): string {
  return (
    ALL_DETECTORS.find((detector) => detector.type === type)?.version ?? ''
  );
}

/**
 * A versão do **conjunto**, para o `meta.provenance` das rotas de leitura.
 *
 * Derivada, nunca escrita à mão: enquanto os dez concordam é um valor só, e no
 * dia em que um deles avançar sozinho a procedência passa a dizer isso em vez de
 * afirmar uma versão que metade do catálogo não tem.
 */
export const DETECTOR_SUITE_VERSION = [
  ...new Set(ALL_DETECTORS.map((detector) => detector.version)),
]
  .sort()
  .join('+');

export type GateOptions = {
  maturityGatingEnabled: boolean;
};

/**
 * Roda um detector de escopo `AD` **sob o portão**.
 *
 * Devolve o achado ou a insuficiência — nunca um `null` mudo. "Não encontramos
 * desperdício" e "não tínhamos como olhar" levam a decisões opostas (P7), e um
 * `null` sem motivo faz o consumidor ler a segunda como a primeira.
 */
export function runAdDetector(
  detector: AdScopedDetector,
  ctx: DetectionContext,
  options: GateOptions,
): DetectionOutcome {
  const insufficiency = evaluateGate({
    type: detector.type,
    ad: ctx.ad,
    score: ctx.score,
    profile: ctx.profile,
    maturityGatingEnabled: options.maturityGatingEnabled,
  });

  if (insufficiency) return { finding: null, insufficiency };

  const noBenchmark = benchmarkGate(detector, ctx);
  if (noBenchmark) return { finding: null, insufficiency: noBenchmark };

  // Passou no portão e não disparou é o caso **saudável**, não insuficiência.
  return { finding: detector.detect(ctx), insufficiency: null };
}

/**
 * Sem anúncio comparável, o detector não tem régua — e isso é dito.
 *
 * O detector continua checando por conta própria (é função pura e não confia
 * em quem o chama); o que muda é que o executor, que sabe o motivo, o reporta
 * como `NO_BENCHMARK` em vez de deixar o `null` do detector ser lido como
 * "olhamos e está tudo bem".
 */
function benchmarkGate(
  detector: AdScopedDetector,
  ctx: DetectionContext,
): DetectionOutcome['insufficiency'] {
  const declared = detector.benchmark;
  if (!declared) return null;

  const peers = ctx.adSetPeers.length;
  const accountSample = ctx.accountBaseline.sampleSize;

  const benchmark = declared.peersOnly
    ? peers >= MIN_BENCHMARK_SAMPLE
      ? true
      : null
    : selectBenchmark({
        peers: ctx.adSetPeers,
        accountBaseline: ctx.accountBaseline,
        metric: declared.metric,
        fallbackMultiplier: 1,
      });

  // A amostra existe mas a métrica não: pares sem CPA não têm mediana de CPA.
  const hasMedian =
    benchmark === true ||
    (benchmark !== null && at(benchmark.percentiles, 50) !== null);

  if (benchmark !== null && hasMedian) return null;

  const current = declared.peersOnly ? peers : Math.max(peers, accountSample);

  return {
    adId: ctx.ad.adId,
    type: detector.type,
    sufficiency: 'INSUFFICIENT',
    code: 'NO_BENCHMARK',
    current,
    required: MIN_BENCHMARK_SAMPLE,
    reason: declared.peersOnly
      ? `${peers} anúncio(s) comparável(is) ${peerScopeOf(ctx.ad).same}; a comparação exige ${MIN_BENCHMARK_SAMPLE}.`
      : `${current} anúncio(s) comparável(is) com o mesmo objetivo; a comparação exige ${MIN_BENCHMARK_SAMPLE}.`,
  };
}

/**
 * Roda um detector de escopo `AD_SET`, com o portão aplicado **depois**.
 *
 * A inversão é necessária, não descuido: o portão é por anúncio, e qual anúncio
 * recebe o achado só se sabe depois da atribuição determinística. Avaliar antes
 * exigiria escolher o alvo duas vezes, por dois caminhos que poderiam divergir —
 * e divergir aqui é o fingerprint mudando entre execuções.
 */
export function runAdSetDetector(
  detector: AdSetScopedDetector,
  ctx: AdSetDetectionContext,
  adsById: Map<string, DetectionContext['ad']>,
  options: GateOptions,
): DetectionOutcome[] {
  return detector.detect(ctx).map((finding) => {
    const ad = adsById.get(finding.adId);
    if (!ad) {
      return {
        finding: null,
        insufficiency: {
          adId: finding.adId,
          type: detector.type,
          sufficiency: 'INSUFFICIENT' as const,
          code: 'AD_LEFT_AD_SET' as const,
          reason: 'O anúncio atribuído saiu do conjunto durante o ciclo.',
        },
      };
    }

    const insufficiency = evaluateGate({
      type: detector.type,
      ad,
      score: ctx.scores.get(finding.adId) ?? null,
      profile: ctx.profile,
      maturityGatingEnabled: options.maturityGatingEnabled,
    });

    return insufficiency
      ? { finding: null, insufficiency }
      : { finding, insufficiency: null };
  });
}

export {
  audienceSaturationDetector,
  budgetStarvationDetector,
  creativeFatigueDetector,
  highCpaDetector,
  learningInstabilityDetector,
  lowCtrDetector,
  lowRoasDetector,
  negativeFeedbackDetector,
  overlappingDeliveryDetector,
  zeroConversionsDetector,
};
