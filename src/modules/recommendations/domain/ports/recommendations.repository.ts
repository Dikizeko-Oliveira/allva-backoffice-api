import type { MoneyView } from 'src/shared/domain/money';
import type { DataMaturity } from 'src/shared/domain/provenance';
import type {
  ImpactType,
  OutcomeDeltaKind,
  RecommendationKind,
  RecommendationPriority,
  RecommendationStatus,
} from '../contracts/recommendation-catalog';
import type { LifecycleCandidate } from '../lifecycle';
import type { PremiseState } from '../premise';
import type { RecommendationPlan } from '../recommendation-plan';
import type { PreWindowSnapshot } from './recommendation-outcomes.repository';

/**
 * Escrita e leitura de `recommendations` (§9.4 passo 5, §7.3).
 *
 * **`impacts[].realized` não existe neste contrato**, e a ausência é B8: o
 * realizado tem uma casa só, `RecommendationOutcome`, e é lido por join.
 * Persistir nos dois lugares os faria divergir em silêncio — e a que erra é
 * sempre a projeção, que ninguém revisita.
 */

export type PersistPlanInput = {
  plan: RecommendationPlan;
  organizationId: string;
  accountId: string;
  currency: string;
  baseCurrency: string;
  engineVersion: string;
  /** `DEFERRED_BY_CONFLICT` traz o alvo disputado e a vencedora. */
  deferral: { conflictWithId: string | null; reason: string } | null;
};

export type PersistedRecommendation = {
  id: string;
  adId: string;
  kind: RecommendationKind;
  actionIds: string[];
};

export type RecommendationActionView = {
  id: string;
  type: string;
  level: string;
  parameters: Record<string, unknown>;
  targetEntityType: string;
  targetEntityId: string;
  scopeWarning: string | null;
  reversible: boolean;
  requiresRecreate: boolean;
};

export type RecommendationView = {
  id: string;
  ad: {
    id: string;
    lineageId: string;
    name: string;
    platform: string;
    externalAdId: string;
    observedStatus: string;
    campaign: { id: string; name: string };
    adSet: { id: string; name: string } | null;
  };
  kind: RecommendationKind;
  advisory: boolean;
  outOfScopeReason: string | null;
  title: string;
  rationale: string;
  guidance: string | null;
  priority: RecommendationPriority;
  status: RecommendationStatus;
  blockedReason: string | null;
  conflictWithId: string | null;
  impacts: Array<{
    type: ImpactType;
    estimated: MoneyView;
    horizonDays: number;
    confidence: number;
    /** Vem de `RecommendationOutcome` por join — nunca de `impacts` (B8). */
    realized: MoneyView | null;
  }>;
  primaryImpactType: OutcomeDeltaKind;
  /** A moeda-base da organização, para o snapshot pré do outcome (R-M, M4). */
  baseCurrency: string;
  wasteItems: Array<{ id: string; type: string; open: boolean }>;
  actions: RecommendationActionView[];
  dataMaturity: DataMaturity | null;
  evidence: Record<string, unknown>;
  evidenceAsOf: Date;
  expiresAt: Date | null;
  engineVersion: string;
};

export type RecommendationListQuery = {
  organizationId: string;
  status?: RecommendationStatus;
  kind?: RecommendationKind;
  adId?: string;
  advisory?: boolean;
  /** `true` devolve só as retidas por guarda; `false`, só as livres. */
  blocked?: boolean;
  limit: number;
  cursor?: { keys: (string | number | boolean | null)[]; id: string };
};

/**
 * §9.7 — três tipos **separados**, estimado e realizado na mesma unidade.
 *
 * **Duas populações de estimativa, não uma.** `openEstimatedBase` é o que ainda
 * há a ganhar; `appliedEstimatedBase` é o que prometemos no instante em que
 * alguém aplicou. Só o segundo é comparável com `observedDeltaBase`: comparar o
 * realizado de dez aplicações com a estimativa de duzentas recomendações abertas
 * produziria uma "taxa de realização" de 5% que não mede nada — mede quantas
 * recomendações ainda não foram aplicadas.
 */
export type ImpactSummary = {
  baseCurrency: string;
  byType: Array<{
    type: ImpactType;
    /** Projeção sobre o que está na tela, esperando decisão. */
    openEstimatedBase: number;
    openCount: number;
    /** Projeção sobre o que foi aplicado — a régua do medido. */
    appliedEstimatedBase: number;
    appliedCount: number;
    /**
     * **`observedDelta`, jamais `causedSavings`** (P7, D6). Isto é medição
     * pré/pós, não atribuição causal, e o nome do campo é onde essa distinção
     * ou sobrevive ou se perde.
     */
    observedDeltaBase: number;
    measuredCount: number;
    /** Acurácia de P8: quantas melhoraram, pioraram, ficaram iguais. */
    byVerdict: Record<string, number>;
  }>;
  /** Consultivas **nunca** entram nas métricas de acurácia de P8. */
  advisoryExcluded: number;
  /** O estado do ciclo de medição, para a tela não confundir "zero" com "ainda não". */
  measurement: {
    pending: number;
    measured: number;
    abandoned: number;
    /** Medições com ao menos um confounder detectado (D6). */
    withConfounders: number;
    /**
     * As versões de medição presentes no recorte.
     *
     * Mais de uma significa que os números vêm de regras diferentes — §20-H3
     * condiciona a automação a 90 dias de histórico, e em 90 dias a lógica muda
     * ao menos uma vez. Exibir a lista é o que impede alguém de somar duas
     * medidas distintas achando que somou uma.
     */
    versions: string[];
  };
};

export abstract class RecommendationsRepositoryInterface {
  /**
   * Persiste plano + ações + vínculos N:N numa transação (§9.4 passo 5).
   *
   * Devolve `null` quando o índice parcial `recommendations_active_unique`
   * recusa a linha: já existe uma ativa para `(ad, kind)`. Recusar é o
   * comportamento correto sob geração concorrente — a alternativa seria duas
   * recomendações idênticas na tela, cada uma com metade dos vínculos.
   */
  abstract persistPlan(
    input: PersistPlanInput,
  ): Promise<PersistedRecommendation | null>;

  /** §9.4 passo 6 — supersede a geração anterior do mesmo `(ad, kind)`. */
  abstract supersede(input: {
    organizationId: string;
    supersededById: string;
    adId: string;
    kind: RecommendationKind;
  }): Promise<number>;

  abstract list(
    query: RecommendationListQuery,
  ): Promise<{ items: RecommendationView[]; hasMore: boolean }>;

  abstract findOne(
    organizationId: string,
    id: string,
  ): Promise<RecommendationView | null>;

  abstract impactSummary(organizationId: string): Promise<ImpactSummary>;

  /** O estado que a revalidação de premissa avalia (§9.5 passo 1). */
  abstract premiseStateFor(input: {
    organizationId: string;
    recommendationId: string;
    evidenceMaxAgeDays: number;
  }): Promise<PremiseState | null>;

  abstract markStatus(input: {
    id: string;
    organizationId: string;
    status: RecommendationStatus;
    reason?: string | null;
  }): Promise<boolean>;

  /**
   * `APPLYING → APPLIED` **com o outcome na mesma transação** (§9.5 passo 6).
   *
   * As duas escritas juntas não são zelo: o "pré" é um fato do instante da
   * aplicação, e uma transação que gravasse `appliedAt` e falhasse ao criar o
   * outcome deixaria uma recomendação aplicada sem régua — a única saída seria
   * reconstruir o pré dias depois, lendo dado que a plataforma já re-declarou
   * (§8.9). O dataset de P8 nasceria contaminado pelo fenômeno que o produto
   * mede em toda parte.
   *
   * A transição só parte de `APPLYING`, e é isso que torna a chamada
   * **idempotente**: a segunda vez devolve `applied: false` sem tocar em nada —
   * um worker reexecutado não cria dois outcomes para a mesma recomendação.
   */
  abstract markApplied(input: {
    id: string;
    organizationId: string;
    appliedAt: Date;
    outcome: PreWindowSnapshot;
  }): Promise<{ applied: boolean; outcomeId: string | null }>;

  /**
   * `NEW|ACKNOWLEDGED → APPLYING` (§9.5 passo 4).
   *
   * Separado de `markStatus` porque o conjunto de partida é outro: `markStatus`
   * atende dispensa e expiração, que **não** podem partir de `APPLYING` — há
   * escrita em voo, e deixar o usuário dispensar no meio dela criaria uma
   * recomendação dispensada cuja ação a plataforma vai executar mesmo assim.
   */
  abstract markApplying(input: {
    id: string;
    organizationId: string;
  }): Promise<boolean>;

  /** `APPLYING → FAILED` com o detalhe por ação (§9.5 passo 5). */
  abstract markApplyFailed(input: {
    id: string;
    organizationId: string;
    reason: string;
  }): Promise<boolean>;

  /**
   * A recomendação **ativa** que responde por um achado (§10.9, linha "por ação").
   *
   * A relação é N:N: um plano coerente responde a vários sinais do mesmo
   * anúncio. `apply-fix` precisa do caminho inverso — do achado para o plano —, e
   * só a ativa serve: aplicar uma recomendação já dispensada resolveria o achado
   * com uma decisão que o usuário recusou.
   */
  abstract findActiveByWasteItem(input: {
    organizationId: string;
    wasteItemId: string;
  }): Promise<{ id: string; adId: string } | null>;

  abstract lifecycleCandidates(
    organizationId: string,
  ): Promise<LifecycleCandidate[]>;

  abstract applyTransitions(
    transitions: Array<{
      id: string;
      to: RecommendationStatus;
      reason: string;
    }>,
  ): Promise<number>;
}
