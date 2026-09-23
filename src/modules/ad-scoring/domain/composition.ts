import {
  COMPONENT_WEIGHTS,
  type ScoreComponentName,
} from './contracts/score-model';
/**
 * A composição do AI Score (§12.1, §12.3) — **duas grandezas por componente e um
 * prior neutro**.
 *
 * Tudo aqui é função pura e versionada em `algoVersion`. É o que torna o número
 * recalculável a partir da linha persistida: sem isso, P7 ("nenhum número sem
 * procedência") fica sem lastro, porque a procedência de um score que ninguém
 * consegue reproduzir é uma afirmação sobre o passado que não dá para conferir.
 */

// O modelo — quais componentes existem e com que peso — é **contrato público**
// e mora em `ports/score-model.ts`: `ads` e `waste` precisam dele sem poder
// importar a aritmética daqui (D2). Reexportado para quem já calcula.
export {
  COMPONENT_WEIGHTS,
  COMPONENT_SIGNALS,
  platformCoverageMaxFor,
  type ScoreComponentName,
} from './contracts/score-model';

/**
 * A escala nativa de cada componente e a direção do "melhor".
 *
 * `value` é a escala nativa da calculadora — é o que os **detectores** consomem,
 * e é por isso que `fatigueScore ≥ 0,65` continua sendo um limiar válido em
 * A2-S5. `normalizedValue` é a escala canônica `0..100` com "maior é melhor" —
 * é o que o **composto** consome.
 *
 * Fundir as duas seria escolher entre quebrar os detectores e tornar o composto
 * incoerente (somar um 0..1 invertido com um 0..100 direto).
 */
export type ComponentScale = {
  min: number;
  max: number;
  /** `true` quando o valor nativo é "menor é melhor" e precisa ser invertido. */
  inverted: boolean;
};

export const COMPONENT_SCALES: Readonly<
  Record<ScoreComponentName, ComponentScale>
> = {
  attention: { min: 0, max: 100, inverted: false },
  audienceFit: { min: 0, max: 100, inverted: false },
  learningStability: { min: 0, max: 100, inverted: false },
  // A calculadora devolve 0..100 onde **maior é mais risco**: o composto quer o
  // oposto, então a normalização inverte.
  negativeFeedbackRisk: { min: 0, max: 100, inverted: true },
  // Fadiga é 0..1 e invertida — a única com escala nativa diferente, e a razão
  // de `ComponentScale` existir em vez de uma constante global.
  fatigue: { min: 0, max: 1, inverted: true },
};

/**
 * Escala nativa → canônica `0..100` ↑.
 *
 * Satura nas pontas em vez de extrapolar: um valor fora da faixa declarada é um
 * defeito da calculadora, e extrapolar o esconderia produzindo um score acima de
 * 100 que a UI renderiza sem reclamar.
 */
export function normalizeComponent(
  component: ScoreComponentName,
  value: number | null,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;

  const scale = COMPONENT_SCALES[component];
  if (scale.max === scale.min) return null;

  const ratio = (value - scale.min) / (scale.max - scale.min);
  const clamped = Math.min(1, Math.max(0, ratio));

  return (scale.inverted ? 1 - clamped : clamped) * 100;
}

export type ComponentInput = {
  /** Escala nativa. `null` quando a plataforma não expõe o sinal. */
  value: number | null;
  /** Confiança da própria calculadora, em [0,1]. */
  confidence: number;
  /**
   * `false` quando a plataforma **não pode** medir este componente — o que é
   * diferente de "mediu e deu ruim". O motivo vem de
   * `PlatformProfile.metrics.unavailable`.
   */
  available: boolean;
};

export type CompositionResult = {
  /** 0..100, o número que o produto chama de AI Score. */
  aiScore: number;
  /** Σ(wᵢcᵢ) / Σwᵢ — sobre **todos** os pesos, não só os disponíveis. */
  aiConfidence: number;
  /** Σwᵢ dos componentes disponíveis / Σwᵢ. É a honestidade absoluta. */
  componentCoverage: number;
  /** Componentes que entraram no número. */
  componentsAvailable: ScoreComponentName[];
  componentsUnavailable: ScoreComponentName[];
};

/**
 * O peso do prior neutro, versionado em `algoVersion`.
 *
 * `k = 1` significa que o prior pesa como um componente inteiro de peso 1,0 —
 * mais que qualquer componente real (o maior é 0,30). É deliberadamente forte:
 * evidência fraca **tem** de puxar o score para o meio, e um `k` tímido devolve
 * o problema que o prior existe para resolver.
 */
export const NEUTRAL_PRIOR = 50;
export const PRIOR_WEIGHT = 1;

/**
 * `aiScore = (Σ wᵢ·cᵢ·nᵢ + k·50) / (Σ wᵢ·cᵢ + k)`
 *
 * **O termo do prior é o que faz a ponderação por confiança funcionar.** Uma
 * média ponderada pura se auto-normaliza pelo denominador: um anúncio de três
 * dias cuja única componente mensurável é fadiga receberia o valor da fadiga
 * como AI Score — tão assertivo quanto o de um anúncio com trinta dias e cinco
 * componentes, apenas com um rótulo de confiança baixa ao lado. Ninguém lê o
 * rótulo; todo mundo lê o número.
 *
 * Com o prior, *"ainda não sei"* tem um lugar na escala, e esse lugar é o meio.
 */
export function composeAiScore(
  components: Partial<Record<ScoreComponentName, ComponentInput>>,
  priorWeight: number = PRIOR_WEIGHT,
): CompositionResult {
  const names = Object.keys(COMPONENT_WEIGHTS) as ScoreComponentName[];

  let weightedSum = priorWeight * NEUTRAL_PRIOR;
  let weightTotal = priorWeight;
  let confidenceNumerator = 0;
  let availableWeight = 0;

  const componentsAvailable: ScoreComponentName[] = [];
  const componentsUnavailable: ScoreComponentName[] = [];

  for (const name of names) {
    const weight = COMPONENT_WEIGHTS[name];
    const input = components[name];
    const normalized = input?.available
      ? normalizeComponent(name, input.value)
      : null;

    if (!input || !input.available || normalized === null) {
      componentsUnavailable.push(name);
      continue;
    }

    const confidence = clamp01(input.confidence);
    componentsAvailable.push(name);
    availableWeight += weight;
    confidenceNumerator += weight * confidence;
    weightedSum += weight * confidence * normalized;
    weightTotal += weight * confidence;
  }

  const totalWeight = names.reduce(
    (sum, name) => sum + COMPONENT_WEIGHTS[name],
    0,
  );

  return {
    aiScore: round2(weightedSum / weightTotal),
    // Divide pela soma de **todos** os pesos: assim um componente ausente reduz
    // a confiança em vez de desaparecer da conta. Dividir só pelos disponíveis
    // faria um anúncio com um único componente perfeito marcar confiança 1,0.
    aiConfidence: round4(confidenceNumerator / totalWeight),
    componentCoverage: round4(availableWeight / totalWeight),
    componentsAvailable,
    componentsUnavailable,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
