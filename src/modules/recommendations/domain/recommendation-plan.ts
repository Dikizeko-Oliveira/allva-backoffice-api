import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { DataMaturity } from 'src/shared/domain/provenance';
import type { ActionLevel } from 'src/modules/ads/domain/platform/platform-profile';
import type {
  FindingKind,
  FindingType,
  WastePriority,
} from 'src/modules/waste/domain/contracts/finding-catalog';
import type {
  AdActionType,
  ImpactType,
  OutcomeDeltaKind,
  RecommendationKind,
  RecommendationPriority,
} from './contracts/recommendation-catalog';

/**
 * O que a política vê, e o que ela devolve (§9.4 passo 3).
 *
 * Não há repositório, Prisma nem relógio: a `RecommendationPolicy` é uma função
 * de sinais para planos. É isso que permite testar as seis guardas de
 * `SCALE_WINNING_AD` nas fronteiras exatas sem container — e elas são as que
 * decidem se o produto manda alguém **aumentar** gasto.
 */

/** Um achado aberto, na forma que a política consome. */
export type FindingSignal = {
  id: string;
  type: FindingType;
  findingKind: FindingKind;
  priority: WastePriority;
  /** O número acionável (§10.1): o que a ação interrompe por dia. */
  avoidableDailyBase: number;
  avoidableDaily: number;
  incurredBase: number;
  evidenceSufficiency: string;
  dataMaturity: DataMaturity | null;
};

/** O score na forma mínima que as guardas exigem. */
export type ScoreSignal = {
  aiScore: number;
  aiConfidence: number;
  coverageRatio: number;
  /** Escala nativa 0..1, maior = mais fatigado (§12.2). */
  fatigueScore: number | null;
  /** Escala nativa 0..100, maior = mais estável. */
  learningStability: number | null;
  /** 0..100 — o público certo está chegando? Distingue CTA de segmentação. */
  audienceFit: number | null;
  /** 0..100, maior = mais risco. */
  negativeFeedbackRisk: number | null;
  /** `null` quando não há 7 dias comparáveis ou houve descontinuidade. */
  delta7d: number | null;
  scoredAt: Date;
};

export type AdSignal = {
  adId: string;
  adSetId: string | null;
  campaignId: string;
  adAccountId: string;
  platform: Platform;
  creativeId: string | null;
  /** `creatives.format` — decide se o CTA é campo deste anúncio (Google). */
  creativeFormat: string | null;
  contentHash: string | null;
  isDelivering: boolean;
  dataMaturity: DataMaturity | null;
  currency: string;
  baseCurrency: string;
  /** Frequência média da janela, quando a plataforma a expõe. */
  frequency: number | null;
  /**
   * Para que o anúncio foi otimizado. Escala e troca de CTA só fazem sentido
   * sobre anúncio julgável por conversão.
   */
  optimization: OptimizationTarget;
  roas: number | null;
  /** Mediana de ROAS dos pares do ad set — o `2×` de `SCALE_WINNING_AD`. */
  peerMedianRoas: number | null;
  /**
   * CPA do anúncio e mediana dos pares, em moeda-base. É a régua quando o
   * evento não carrega valor — lead, cadastro, instalação —, onde ROAS não
   * existe e o anúncio campeão é o que converte **mais barato**.
   */
  cpa: number | null;
  peerMedianCpa: number | null;
  /** Orçamento diário atual do conjunto e da campanha, na moeda da conta (M3). */
  adSetDailyBudget: number | null;
  campaignDailyBudget: number | null;
};

/**
 * Limiares que a política consome, resolvidos **fora** dela.
 *
 * Vêm do `DetectorProfile` da organização e dos pisos de §12.4. Passá-los como
 * dado mantém a política pura e mantém a calibração no lugar onde §10.4 a
 * colocou — configuração versionada, não literal no corpo da regra.
 */
export type PolicyThresholds = {
  /** §9.3: `aiScore ≥ 75` para sequer considerar escalar. */
  scaleMinScore: number;
  /** §12.4: o piso mais alto do catálogo, o da única ação que aumenta gasto. */
  scaleMinConfidence: number;
  scaleMinCoverageRatio: number;
  /**
   * `ROAS ≥ 2× a mediana dos pares` — ou, quando o evento não tem valor,
   * `CPA ≤ metade da mediana`: a mesma vantagem de 2×, na régua que existe.
   */
  scaleRoasMultiple: number;
  /** Guarda de fadiga: bloqueia em `fatigueScore ≥ 0,5`. */
  scaleMaxFatigue: number;
  /** Guarda de frequência: o limiar do `DetectorProfile`. */
  saturationFrequency: number;
  /** Guarda de estabilidade: `learningStability` abaixo disto bloqueia. */
  minLearningStability: number;
  /**
   * Quanto o ajuste de orçamento mexe, como **fração declarada**.
   *
   * Um número mágico dentro da política seria a única parte do plano que
   * ninguém consegue calibrar sem deploy — e §10.4 tirou exatamente esse tipo de
   * literal do corpo das regras. Reduzir é o único sentido permitido fora de
   * `SCALE_WINNING_AD`, que é a única recomendação que aumenta gasto.
   */
  budgetReductionFactor: number;
  scaleIncreaseFactor: number;
  /** Horizonte da projeção de impacto, em dias (§9.7). */
  impactHorizonDays: number;
  /** Prazo de validade da evidência — depois disso, premissa vencida. */
  expiryDays: number;
};

export type RecommendationSignals = {
  ad: AdSignal;
  findings: FindingSignal[];
  score: ScoreSignal | null;
  /** Achados abertos **do conjunto**, para a guarda de saturação. */
  adSetFindingTypes: FindingType[];
  /** §11.4 — sem candidato, `REFRESH_FATIGUED_CREATIVE` vira consultiva. */
  replacementCreativeId: string | null;
  replacementRationale: string | null;
  /**
   * A variação de copy escolhida no Copy Studio, se houver.
   *
   * Mesmo papel de `replacementCreativeId` e pelo mesmo motivo: sem ela,
   * `IMPROVE_WEAK_HOOK` e `REPLACE_CTA` continuam consultivas porque o
   * parâmetro de texto não tem fonte. Com ela, a recomendação passa a propor
   * uma ação executável — e R14 continua exigindo a confirmação do texto final
   * na hora de executar.
   */
  selectedCopy: SelectedCopy | null;
  thresholds: PolicyThresholds;
  now: Date;
};

/**
 * O texto que já foi escolhido no Copy Studio, com a autoria declarada.
 *
 * Mora aqui, ao lado de `PlannedAction`, porque `action-level` já importa deste
 * arquivo — declará-lo lá e importá-lo aqui fecharia um ciclo entre os dois.
 *
 * `aiAuthored` viaja junto do texto e **não é inferido no destino**: o schema de
 * `REPLACE_COPY` o exige, e R14 o usa para decidir se a confirmação explícita do
 * conteúdo final é obrigatória. Deduzi-lo em outro lugar criaria um caminho em
 * que texto de LLM chega à plataforma declarado como humano.
 */
export type SelectedCopy = {
  variantId: string;
  primaryText: string | null;
  callToAction: string | null;
  aiAuthored: boolean;
};

/** Uma ação planejada, antes de o nível ser resolvido contra a plataforma. */
export type PlannedAction = {
  type: AdActionType;
  level: ActionLevel;
  /** Sustenta a I2 generalizada: a exclusão é por **alvo**, não por anúncio. */
  targetEntityType: 'AD' | 'AD_SET' | 'CAMPAIGN';
  targetEntityId: string;
  /** Valores monetários **sempre na moeda da conta** (M3). */
  parameters: Record<string, unknown>;
  scopeWarning: string | null;
  reversible: boolean;
  requiresRecreate: boolean;
};

export type EstimatedImpact = {
  type: ImpactType;
  estimatedBase: number;
  horizonDays: number;
  confidence: number;
};

export type RecommendationPlan = {
  adId: string;
  kind: RecommendationKind;
  advisory: boolean;
  priority: RecommendationPriority;
  title: string;
  rationale: string;
  /** Texto de conduta das consultivas — o que fazer na plataforma. */
  guidance: string | null;
  outOfScopeReason: string | null;
  /**
   * §9.3: bloqueio **não some em silêncio**. A recomendação é gerada com o
   * motivo visível — informação ao usuário e sinal de calibração para P8.
   */
  blockedReason: string | null;
  wasteItemIds: string[];
  impacts: EstimatedImpact[];
  primaryImpactType: OutcomeDeltaKind;
  actions: PlannedAction[];
  evidence: Record<string, unknown>;
  evidenceAsOf: Date;
  expiresAt: Date;
};
