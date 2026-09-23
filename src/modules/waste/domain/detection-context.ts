import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { EvidenceSufficiency } from 'src/shared/domain/provenance';
import type {
  FindingKind,
  FindingType,
  ScopeLevel,
  WastePriority,
} from './contracts/finding-catalog';
import type { DetectorProfile } from './detector-profile';
import type { BenchmarkMetric } from './benchmark';
import type { WasteEvidence } from './schemas/waste-evidence.schema';

/**
 * O que um detector vê (§10.3) — e, tão importante quanto, o que ele **não** vê.
 *
 * Não há `PrismaService`, não há repositório e não há relógio: um detector é uma
 * função pura de contexto para achado. É isso que permite testar os dez contra
 * fronteiras exatas sem container, e é isso que torna verificável a afirmação de
 * que nenhum deles dispara abaixo da evidência mínima.
 */

/** Um dia da série, já normalizado para moeda-base (M1). */
export type DailyPoint = {
  date: Date;
  /** Moeda da conta — o que a plataforma reportou (R-M). */
  spend: number;
  revenue: number;
  /** Moeda-base da organização. **É o que a inteligência compara** (M1). */
  spendBase: number;
  revenueBase: number;
  impressions: number;
  clicks: number;
  conversions: number;
  frequency: number | null;
};

/**
 * O agregado do anúncio na janela.
 *
 * Carrega as duas moedas lado a lado porque `WasteItem` persiste as duas (R-M) e
 * derivar uma da outra no momento da escrita exigiria taxa de câmbio dentro do
 * detector — o que quebraria tanto a pureza quanto a regra de que só `currency`
 * toca `fx_rates` (§16.10). Aqui elas já vêm da série, calculadas com a mesma
 * fórmula em paralelo.
 */
export type AdWindowAggregate = {
  adId: string;
  adSetId: string | null;
  campaignId: string;
  adAccountId: string;
  platform: Platform;
  /**
   * Anúncio ou grupo de recursos (D23). Grupo de recursos não tem conjunto:
   * compara-se com os da mesma campanha e contra uma régua só dele.
   */
  unitKind: AdUnitKind;
  creativeId: string | null;
  /** DEC-5: entrega sobreposta é conteúdo idêntico, e o hash é o que o prova. */
  contentHash: string | null;
  /** `false` para pausado e arquivado: não há gasto futuro a interromper. */
  isDelivering: boolean;
  /**
   * Para que o anúncio foi otimizado, e o que conta como conversão nele.
   *
   * Decide duas coisas: se os detectores de conversão podem julgá-lo (portão
   * de objetivo em `evidence.ts`) e com quem ele se compara na linha de base da
   * conta — CPA de lead não entra na mediana de CPA de compra.
   */
  optimization: OptimizationTarget;

  currency: string;
  baseCurrency: string;

  daily: DailyPoint[];
  /** Dias **com observação** na janela — o que a evidência mínima conta. */
  days: number;

  spend: number;
  spendBase: number;
  revenue: number;
  revenueBase: number;
  impressions: number;
  clicks: number;
  conversions: number;

  /** Em porcentagem (1,8 = 1,8%), a mesma unidade da série. */
  ctr: number | null;
  /** Em **moeda-base**: comparar CPA entre contas em moedas distintas exige. */
  cpa: number | null;
  roas: number | null;

  /**
   * Dono: `sync`, denormalizada em `Ad.dataMaturity` (§5.4). `null` quando não
   * há dia observado — e `null` **nunca** satisfaz maturidade mínima, porque
   * ausência de observação não é observação madura.
   */
  dataMaturity: DataMaturity | null;
  /**
   * §10.7 passo 1/7: a conta teve leitura válida cobrindo esta janela?
   *
   * `false` congela o auto-resolve do anúncio inteiro. Ausência de dado nunca é
   * evidência de resolução — sem isto, uma integração fora do ar por uma noite
   * resolveria todo o desperdício aberto da organização como "condição cessou".
   */
  hasValidObservation: boolean;
  /** Linhas fora por falta de taxa do dia (M1) — degrada, nunca some. */
  excludedByNormalization: number;
};

/**
 * Mediana e percentis — **nunca média** (§10.3, Apêndice A nº 7).
 *
 * Um outlier de CPA arrasta a média e não move a mediana; com média, o anúncio
 * mais caro da conta eleva o próprio benchmark e deixa de ser detectável.
 */
export type Baseline = {
  /** Quantos anúncios sustentam a linha de base. */
  sampleSize: number;
  cpa: Percentiles;
  ctr: Percentiles;
  roas: Percentiles;
  impressions: Percentiles;
};

export type Percentiles = {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
};

export type DetectionContext = {
  ad: AdWindowAggregate;
  /**
   * Pares do **mesmo ad set**, sem o próprio anúncio — benchmark correto. Sem
   * conjunto (o grupo de recursos), os da mesma campanha: `peerGroupKeyOf`.
   */
  adSetPeers: AdWindowAggregate[];
  /** Linha de base da conta, para a queda declarada de DEC-3. */
  accountBaseline: Baseline;
  /** `null` é insuficiência declarada: `evidenceSufficiency: MISSING_SCORE`. */
  score: AdScoreView | null;
  windowDays: number;
  profile: DetectorProfile;
};

export type AdSetDetectionContext = {
  adSetId: string;
  /** Todos os anúncios do conjunto, incluindo os que não vão receber o achado. */
  ads: AdWindowAggregate[];
  scores: Map<string, AdScoreView>;
  accountBaseline: Baseline;
  windowDays: number;
  profile: DetectorProfile;
};

/** As duas grandezas de §10.1, nas duas moedas de R-M. */
export type FindingAmount = { value: number; valueBase: number };

export type Finding = {
  adId: string;
  type: FindingType;
  kind: FindingKind;
  priority: WastePriority;
  /** Texto de tela: o que foi observado, com número, não um rótulo. */
  diagnosis: string;

  /** Passado: "quanto já queimei com este problema?". */
  incurred: FindingAmount;
  /** Futuro: "quanto queimo por dia se não fizer nada?" — o número acionável. */
  avoidableDaily: FindingAmount;
  currency: string;
  baseCurrency: string;

  evidence: WasteEvidence;
  evidenceSufficiency: EvidenceSufficiency;
  scopeLevel: ScopeLevel;
  dataMaturity: DataMaturity | null;
  detectorVersion: string;
};

/**
 * Por que um detector **não** rodou — reportado, nunca convertido em ausência de
 * problema (P7).
 *
 * "Não encontramos desperdício" e "não tínhamos como olhar" levam a decisões
 * opostas, e achatá-las num `null` silencioso faz o usuário concluir a primeira
 * quando a verdade é a segunda.
 */
export type Insufficiency = {
  adId: string;
  type: FindingType;
  sufficiency: Exclude<EvidenceSufficiency, 'SUFFICIENT' | 'PARTIAL'>;
  /**
   * O **motivo** como código, para a tela agrupar e estimar quando a evidência
   * chega (`evidence-gaps.ts`). `reason` continua sendo o texto de uma linha.
   */
  code: EvidenceGapCode;
  reason: string;
  /** O que falta, quando o motivo é um número: valor atual e mínimo declarado. */
  current?: number;
  required?: number;
};

/**
 * Por que um detector não julgou um anúncio — os motivos possíveis.
 *
 * Três naturezas, e a tela trata cada uma de um jeito (`evidence-gaps.ts`):
 *
 * - **esperando dado** (`AWAITING_*`, `OBJECTIVE_UNKNOWN`): muda sozinho com o
 *   tempo, e dá para estimar quando;
 * - **estrutural** (`NO_BENCHMARK`): depende da conta — com menos de três
 *   anúncios comparáveis não há mediana, por mais que se espere;
 * - **não se aplica** (`OBJECTIVE_NOT_CONVERSION`, `CONVERSION_NOT_MEASURABLE`,
 *   `COMPONENT_UNAVAILABLE`): o anúncio não é julgável por aquele detector, e
 *   isso é informação, não pendência.
 */
export type EvidenceGapCode =
  | 'AWAITING_DAYS'
  | 'AWAITING_IMPRESSIONS'
  | 'AWAITING_SPEND'
  | 'AWAITING_CONVERSIONS'
  | 'AWAITING_MATURITY'
  | 'AWAITING_SCORE'
  | 'OBJECTIVE_UNKNOWN'
  | 'NO_BENCHMARK'
  | 'OBJECTIVE_NOT_CONVERSION'
  | 'CONVERSION_NOT_MEASURABLE'
  | 'COMPONENT_UNAVAILABLE'
  | 'AD_LEFT_AD_SET';

/**
 * Os **três** desfechos possíveis, e os três são diferentes:
 *
 * | `finding` | `insufficiency` | Significado |
 * |---|---|---|
 * | preenchido | `null` | achado |
 * | `null` | preenchida | não deu para olhar — reportado (P7) |
 * | `null` | `null` | olhamos e está tudo bem |
 *
 * A terceira linha é a que uma união de dois casos perderia. Marcar o anúncio
 * saudável como "insuficiente" encheria a resposta de ruído e faria o rótulo
 * `PARTIAL` perder significado por inflação — e é justamente o rótulo que existe
 * para o usuário saber quando desconfiar.
 */
export type DetectionOutcome = {
  finding: Finding | null;
  insufficiency: Insufficiency | null;
};

export interface AdScopedDetector {
  readonly scope: 'AD';
  readonly type: FindingType;
  readonly version: string;
  /**
   * A comparação sem a qual o detector não tem o que dizer.
   *
   * Declarada para o executor reportar `NO_BENCHMARK` em vez de o detector
   * devolver um `null` mudo — "sem anúncio comparável" e "está tudo bem" são
   * respostas diferentes (P7). `peersOnly` exige pares do mesmo conjunto, sem a
   * queda para a linha de base da conta.
   */
  readonly benchmark?: { metric: BenchmarkMetric; peersOnly?: boolean };
  detect(ctx: DetectionContext): Finding | null;
}

export interface AdSetScopedDetector {
  readonly scope: 'AD_SET';
  readonly type: FindingType;
  readonly version: string;
  /** Avalia o conjunto e devolve achados **já atribuídos** a anúncios. */
  detect(ctx: AdSetDetectionContext): Finding[];
}

export type Detector = AdScopedDetector | AdSetScopedDetector;
