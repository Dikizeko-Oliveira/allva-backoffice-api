import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import {
  describeOptimization,
  judgesConversion,
  type OptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  type ComponentInput,
  type ScoreComponentName,
  composeAiScore,
  normalizeComponent,
} from './composition';
import { computeCoverage } from './coverage';
import { AttentionScoreCalculator } from './scoring/attention-score.calculator';
import { AudienceFitScoreCalculator } from './scoring/audience-fit-score.calculator';
import { CreativeMetricsAggregator } from './scoring/creative-metrics-aggregator';
import { FatigueSaturationCalculator } from './scoring/fatigue-saturation.calculator';
import { LearningStabilityScoreCalculator } from './scoring/learning-stability-score.calculator';
import { NegativeFeedbackRiskCalculator } from './scoring/negative-feedback-risk.calculator';
import type { PortfolioBenchmarks, ScoreResult } from './scoring/score-types';
import { comparableWindow, markResumedAfterPause } from './series-continuity';
import type { PersistedComponent } from './ports/ad-scores.repository';
import { usableForIntelligence } from './score-input';

/**
 * O cálculo de um `AdScore` — **função pura**, sem I/O e sem relógio interno.
 *
 * Recebe a série já lida, devolve o score. É essa pureza que permite testar a
 * composição, a cobertura e a descontinuidade nas fronteiras sem container e sem
 * banco — e é ela que faz o número ser recalculável a partir da linha
 * persistida, que é o que P7 exige de qualquer coisa que o produto afirme.
 *
 * A ordem interna importa e é a de §15.2: **a descontinuidade corta a janela
 * antes de qualquer componente ser calculado.** Calcular primeiro e cortar
 * depois produziria componentes que misturam duas réguas — e o corte deixaria de
 * proteger justamente o que existe para proteger.
 */

export type ScoreCalculationInput = {
  platform: Platform;
  /** A série da janela, em ordem de data. Já em moeda-base (M1). */
  rows: AdMetricSnapshotRow[];
  /** Pares do mesmo ad set, para a eficiência relativa de `audienceFit`. */
  benchmarks?: PortfolioBenchmarks;
  algoVersion: string;
  priorWeight: number;
  windowDays: number;
  /**
   * Para que o anúncio foi otimizado. Omitido preserva o comportamento
   * anterior (`audienceFit` pelo sinal de clique/conversão), para quem ainda
   * não resolve o objetivo.
   */
  optimization?: OptimizationTarget;
  /**
   * `true` quando a plataforma passou a expor sinais que antes não expunha.
   * Quem sabe disso é o deploy, não a série — por isso entra como parâmetro.
   */
  newSignalArrived?: boolean;
};

export type ScoreCalculation = {
  aiScore: number;
  aiConfidence: number;
  componentCoverage: number;
  coverageRatio: number;
  platformCoverageMax: number;
  components: Record<ScoreComponentName, PersistedComponent>;
  context: Record<string, unknown>;
  seriesDiscontinuity: string | null;
  /** Quantos dias entraram de fato no cálculo, depois de todos os cortes. */
  daysUsed: number;
  /** Linhas fora por falta de taxa de câmbio (M1) — reportado, nunca escondido. */
  excludedByNormalization: number;
  /** Pontos descartados pelo corte de descontinuidade. */
  droppedByDiscontinuity: number;
};

export function calculateAdScore(
  input: ScoreCalculationInput,
): ScoreCalculation {
  // 1. Linhas sem taxa de câmbio ficam fora da inteligência (M1). Somá-las com
  //    `spendBase = 0` faria o gasto do período encolher em silêncio.
  const { usable, excludedByNormalization } = usableForIntelligence(input.rows);

  // 2. A descontinuidade é marcada e **então** corta — nesta ordem (§15.2).
  const marked = markResumedAfterPause(usable);
  const withNewSignal = input.newSignalArrived
    ? markNewSignalOnLatest(marked)
    : marked;
  const window = comparableWindow(withNewSignal);

  // 3. Só agora os componentes são calculados, sobre uma janela comparável.
  const aggregate = CreativeMetricsAggregator.aggregate(window.points);

  const attention = AttentionScoreCalculator.calculate(aggregate);
  const audienceFit = AudienceFitScoreCalculator.calculate(
    aggregate,
    input.benchmarks,
  );
  const learningStability =
    LearningStabilityScoreCalculator.calculate(aggregate);
  const negativeFeedbackRisk =
    NegativeFeedbackRiskCalculator.calculate(aggregate);
  const fatigue = FatigueSaturationCalculator.fatigueScore(aggregate);

  // Disponibilidade é sobre o SINAL, não sobre o resultado. Uma calculadora que
  // devolve o seu fallback (Attention sem vídeo, AudienceFit sem conversão) não
  // mediu nada — publicar isso como componente disponível seria transformar
  // "não sei" em evidência.
  const hasVideoSignal =
    aggregate.averages.thumbstopRate !== null ||
    aggregate.averages.holdRate !== null;
  // **Gasto não é evidência de fit.** `roas` vale 0 — e não `null` — assim que
  // houver qualquer gasto, então aceitar `roas !== null` marcaria como "fit
  // medido = péssimo" todo anúncio que gastou dez reais e ainda não converteu.
  // O prior neutro não salva esse caso: ele só puxa para o meio o que está
  // ausente, e um componente que se declara **disponível** com o pior valor
  // possível entra no composto com peso total.
  //
  // ROAS zero com quinhentos cliques é fit ruim de verdade; ROAS zero com zero
  // cliques é ninguém ter chegado lá. A diferença é o clique.
  //
  // **E conversão só se mede em quem a buscou.** Um anúncio de alcance com
  // quinhentos cliques e nenhuma compra não tem fit ruim: ele não otimizou para
  // compra. Sem esta condição, `audienceFit` entrava como "péssimo" (peso 0,30)
  // em todo anúncio de tráfego, alcance ou lead do Meta, e o AI Score deles
  // media o objetivo, não o desempenho.
  const judgedByConversion = input.optimization
    ? judgesConversion(input.optimization)
    : true;
  const hasConversionSignal =
    judgedByConversion &&
    (aggregate.totals.conversions > 0 ||
      (aggregate.totals.clicks > 0 && aggregate.totals.spend > 0));
  const hasFrequencySignal = aggregate.averages.frequency !== null;
  const hasNegativeFeedbackSignal = window.points.some(
    (row) =>
      row.hides !== null ||
      row.hideAllFor !== null ||
      row.reports !== null ||
      row.unlikes !== null,
  );

  const inputs: Record<ScoreComponentName, ComponentInput> = {
    attention: {
      value: attention.value,
      confidence: attention.confidence,
      available: hasVideoSignal && aggregate.days > 0,
    },
    audienceFit: {
      value: audienceFit.value,
      confidence: audienceFit.confidence,
      available: hasConversionSignal,
    },
    learningStability: {
      value: learningStability.value,
      confidence: learningStability.confidence,
      // Variância exige série: dois dias não distinguem estabilidade de acaso.
      available: aggregate.days >= 3,
    },
    negativeFeedbackRisk: {
      value: negativeFeedbackRisk.value,
      confidence: negativeFeedbackRisk.confidence,
      available: hasNegativeFeedbackSignal,
    },
    fatigue: {
      value: fatigue,
      // A calculadora de fadiga não devolve confiança própria; ela vem do que
      // sustenta o sinal — frequência presente e série suficiente.
      confidence: hasFrequencySignal ? Math.min(1, aggregate.days / 7) : 0,
      available: hasFrequencySignal,
    },
  };

  const composition = composeAiScore(inputs, input.priorWeight);
  const coverage = computeCoverage({
    platform: input.platform,
    componentsAvailable: composition.componentsAvailable,
    // O mesmo sinal que decide `attention.available`: se a janela nunca
    // produziu thumbstop/hold, o teto de cobertura para de cobrar o peso de
    // vídeo que este anúncio não tem como pagar (§12.4, dívida B7-bis).
    hasVideoFormat: hasVideoSignal,
    judgedByConversion: input.optimization ? judgedByConversion : undefined,
    optimizationLabel: input.optimization
      ? describeOptimization(input.optimization)
      : undefined,
  });

  return {
    aiScore: composition.aiScore,
    aiConfidence: composition.aiConfidence,
    componentCoverage: composition.componentCoverage,
    coverageRatio: coverage.coverageRatio,
    platformCoverageMax: coverage.platformCoverageMax,
    components: {
      attention: persist('attention', attention, inputs.attention, coverage),
      audienceFit: persist(
        'audienceFit',
        audienceFit,
        inputs.audienceFit,
        coverage,
      ),
      learningStability: persist(
        'learningStability',
        learningStability,
        inputs.learningStability,
        coverage,
      ),
      negativeFeedbackRisk: {
        ...persist(
          'negativeFeedbackRisk',
          negativeFeedbackRisk,
          inputs.negativeFeedbackRisk,
          coverage,
        ),
        // §12.2, dívida declarada: enquanto os sinais reais não chegam, o
        // componente mede **outra coisa** — não a mesma com menos confiança.
        proxyBased: !hasNegativeFeedbackSignal,
      },
      // Fadiga não devolve `ScoreResult`: a calculadora entrega um número 0..1,
      // que é o contrato que os detectores de A2-S5 consomem. O adaptador é aqui
      // e não lá — mudar a assinatura dela quebraria `fatigueScore >= 0,65`.
      fatigue: persist(
        'fatigue',
        { value: fatigue, confidence: inputs.fatigue.confidence, reasons: [] },
        inputs.fatigue,
        coverage,
      ),
    },
    // `saturationRisk` é do AD SET, imputado ao anúncio, e **nunca** entra no
    // número que o produto chama de AI Score (§12.1). Vive aqui como contexto.
    context: {
      saturationRisk: {
        value: null,
        scopeLevel: 'AD_SET',
        reason:
          'Calculado sobre o conjunto inteiro pelo detector de saturação; aqui é contexto declarado.',
      },
    },
    seriesDiscontinuity: window.cutBy,
    daysUsed: aggregate.days,
    excludedByNormalization,
    droppedByDiscontinuity: window.droppedBefore,
  };
}

function persist(
  name: ScoreComponentName,
  result: Pick<ScoreResult, 'value' | 'confidence' | 'reasons'>,
  input: ComponentInput,
  coverage: { unavailableReasons: Partial<Record<ScoreComponentName, string>> },
): PersistedComponent {
  return {
    // O valor nativo é preservado mesmo quando o componente não entra no
    // composto: a tela mostra o que foi medido, e o detector de A2-S5 consome a
    // escala nativa. Sumir com ele apagaria informação já apurada.
    value: result.value,
    normalizedValue: input.available
      ? normalizeComponent(name, result.value)
      : null,
    confidence: input.confidence,
    available: input.available,
    unavailableReason: input.available
      ? null
      : (coverage.unavailableReasons[name] ?? null),
    reasons: result.reasons,
  };
}

/**
 * Marca o dia mais recente como `NEW_SIGNAL`.
 *
 * É o dia do deploy: a partir dele o componente mede outra coisa, e comparar com
 * o que veio antes é comparar réguas diferentes. Marcar o dia mais antigo, ou
 * todos, cortaria a série no lugar errado — e cortar tudo é o mesmo que não ter
 * série.
 */
function markNewSignalOnLatest(
  rows: AdMetricSnapshotRow[],
): AdMetricSnapshotRow[] {
  if (rows.length === 0) return rows;

  const latest = rows.reduce((newest, row) =>
    row.date > newest.date ? row : newest,
  );

  return rows.map((row) =>
    row === latest && !row.seriesDiscontinuity
      ? { ...row, seriesDiscontinuity: 'NEW_SIGNAL' }
      : row,
  );
}
