import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import {
  adCoverageMaxFor,
  COMPONENT_SIGNALS,
  COMPONENT_WEIGHTS,
  platformCoverageMaxFor,
  VIDEO_ONLY_SIGNALS,
  type ScoreComponentName,
} from './contracts/score-model';

export { platformCoverageMaxFor };

/**
 * As **três grandezas** de cobertura (§12.2, achado B7, decisão DEC-2).
 *
 * ```text
 * componentCoverage   = Σ wᵢ (componentes disponíveis)      / Σ wᵢ (todos)
 * platformCoverageMax = Σ wᵢ (mensuráveis NESTA plataforma) / Σ wᵢ (todos)
 * coverageRatio       = componentCoverage / platformCoverageMax
 * ```
 *
 * **Por que o piso não pode ser absoluto.** Um anúncio de Search no Google não
 * tem `attention` (0,25), não tem `negativeFeedbackRisk` (0,15) e não tem
 * `frequency` → `fatigue` (0,15): cobertura absoluta 0,45, abaixo do piso de
 * 0,60 que §12.4 exige para **toda ordenação e todo alerta**. Com piso absoluto,
 * o produto que se define como multi-plataforma some da tela que o define — e
 * não por bug, mas por consequência lógica das regras.
 *
 * Com `coverageRatio`, o mesmo anúncio com os três componentes que a plataforma
 * expõe marca 1,0 e **entra**; o mesmo anúncio sem dados para `audienceFit` cai
 * e sai, que é o comportamento correto.
 */

export type CoverageBreakdown = {
  /** "Quanto do modelo este score cobre?" — **exibido**, é a honestidade absoluta. */
  componentCoverage: number;
  /** "Quanto do modelo esta plataforma permite cobrir?" — vem do perfil. */
  platformCoverageMax: number;
  /** "Este score é o melhor que esta plataforma permite?" — **os pisos incidem aqui**. */
  coverageRatio: number;
  /** Componente → por que a plataforma não o mede. Vai para a tela (P7). */
  unavailableReasons: Partial<Record<ScoreComponentName, string>>;
};

/**
 * As três grandezas de uma vez.
 *
 * `coverageRatio` é 0 quando a plataforma não permite medir nada — e não 1. A
 * divisão `0/0` daria `NaN` e um `?? 1` daria "cobertura perfeita" a uma
 * plataforma que não mede coisa alguma, que é o pior default possível.
 */
export function computeCoverage(input: {
  platform: Platform;
  componentsAvailable: ScoreComponentName[];
  /**
   * Este anúncio produz sinal de vídeo? `false` troca o teto pleno da
   * plataforma (`platformCoverageMaxFor`) pelo teto sem vídeo
   * (`nonVideoCoverageMaxFor`) — sem isso, um carrossel de imagem paga o peso
   * de `attention` no piso de cobertura sem nunca poder gerar o sinal (§12.4,
   * dívida B7-bis). Omitido preserva o teto pleno, para quem ainda não sabe o
   * formato do anúncio.
   */
  hasVideoFormat?: boolean;
  /**
   * O anúncio é julgável por conversão? `false` tira o peso de `audienceFit`
   * do teto — anúncio de alcance não tem aderência de conversão a medir — e
   * dá o motivo certo na tela. Omitido preserva o teto pleno.
   */
  judgedByConversion?: boolean;
  /** A frase do objetivo, para o motivo de `audienceFit` ("tráfego", "alcance"...). */
  optimizationLabel?: string;
}): CoverageBreakdown {
  const profile = platformProfile(input.platform);
  const available = new Set(input.componentsAvailable);

  const total = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
  const covered = input.componentsAvailable.reduce(
    (sum, component) => sum + COMPONENT_WEIGHTS[component],
    0,
  );

  const componentCoverage = total === 0 ? 0 : covered / total;
  const platformCoverageMax =
    input.hasVideoFormat === false || input.judgedByConversion === false
      ? adCoverageMaxFor(input.platform, {
          hasVideoFormat: input.hasVideoFormat,
          judgedByConversion: input.judgedByConversion,
        })
      : platformCoverageMaxFor(input.platform);

  const unavailableReasons: Partial<Record<ScoreComponentName, string>> = {};

  for (const component of Object.keys(
    COMPONENT_WEIGHTS,
  ) as ScoreComponentName[]) {
    if (available.has(component)) continue;

    const signals = COMPONENT_SIGNALS[component];

    // O motivo vem do perfil da plataforma quando existe: é a diferença entre
    // "esta plataforma não mede isso" e "não conseguimos medir desta vez", e a
    // primeira é informação de produto que a tela precisa mostrar (P7).
    const declaredReason = signals
      .map((signal) => profile.metrics.unavailable[signal])
      .find((declared): declared is string => Boolean(declared));

    // Terceiro motivo, distinto dos dois acima: a plataforma mede o sinal —
    // só não **neste** anúncio, porque o formato dele não produz vídeo. Sem
    // isto, um carrossel de imagem herdava "sem dados suficientes na janela",
    // que sugere "tente de novo depois" para algo que nunca vai mudar.
    const isVideoOnlyGap =
      input.hasVideoFormat === false &&
      signals.length > 0 &&
      signals.every((signal) => VIDEO_ONLY_SIGNALS.has(signal));

    // Quarto motivo: o anúncio não busca conversão. "Sem dados" sugeriria
    // esperar por um sinal que o objetivo dele nunca vai gerar.
    const isObjectiveGap =
      component === 'audienceFit' && input.judgedByConversion === false;

    unavailableReasons[component] = isObjectiveGap
      ? `O anúncio otimiza para ${input.optimizationLabel ?? 'um objetivo que não é conversão'}; aderência de conversão não se aplica.`
      : (declaredReason ??
        (isVideoOnlyGap
          ? 'Métrica de vídeo; este anúncio não é de vídeo.'
          : 'Sem dados suficientes na janela analisada.'));
  }

  return {
    componentCoverage: round4(componentCoverage),
    platformCoverageMax,
    coverageRatio:
      platformCoverageMax === 0
        ? 0
        : round4(Math.min(1, componentCoverage / platformCoverageMax)),
    unavailableReasons,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
