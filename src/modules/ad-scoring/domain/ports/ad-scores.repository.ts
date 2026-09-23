import type { ScoreComponentName } from '../composition';

/**
 * A escrita da série de score — **append-only** (§12.5).
 *
 * Nunca `update`: cada execução grava uma linha nova. Recalcular no lugar
 * apagaria a evidência de como o score era ontem, e é exatamente essa evidência
 * que sustenta "por que este anúncio caiu?" — a pergunta que o produto existe
 * para responder. A unique é `(adId, scoreDate, algoVersion, scoredAt)`: duas
 * versões de algoritmo convivem no mesmo dia, e é assim que uma versão em sombra
 * é comparada offline sem aparecer no produto.
 */

export type PersistedComponent = {
  /** Escala nativa — o que os detectores consomem (`fatigueScore ≥ 0,65`). */
  value: number | null;
  /** 0..100 ↑ — o que o composto consome. */
  normalizedValue: number | null;
  confidence: number;
  available: boolean;
  /** Motivo declarado quando `available: false` (P7). */
  unavailableReason?: string | null;
  reasons: string[];
  /**
   * §12.2 — o componente mede **outra coisa** enquanto os sinais reais não
   * chegam. Não é confiança baixa: é outra medida, e a chegada dos sinais gera
   * `seriesDiscontinuity`.
   */
  proxyBased?: boolean;
};

export type AdScoreWrite = {
  adId: string;
  organizationId: string;
  creativeId: string | null;

  scoreDate: Date;
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
  algoVersion: string;
  priorWeight: number;

  aiScore: number;
  aiConfidence: number;
  componentCoverage: number;
  coverageRatio: number;
  platformCoverageMax: number;

  components: Record<ScoreComponentName, PersistedComponent>;
  /** Contexto fora do composto — `saturationRisk` com `scopeLevel: AD_SET`. */
  context: Record<string, unknown> | null;

  seriesDiscontinuity: string | null;
  /** Ad pausado/arquivado: o último score é congelado, não recalculado. */
  frozenAt: Date | null;

  /** P9 — sem mudança de digest, nada recomputa e nenhum LLM é chamado. */
  inputDigest: string;
};

/**
 * A denormalização de leitura em `ads` (§5.4, grupo do `ad-scoring`).
 *
 * `currentScoreCoverage` recebe **`coverageRatio`**, não `componentCoverage`.
 * §12.4 diz que a coluna existe "justamente para que estes pisos sejam
 * aplicáveis em `WHERE`", e os pisos incidem sobre a razão. Guardar a absoluta
 * ali faria todo filtro de cobertura excluir Search do Google em silêncio — o
 * bug que DEC-2 existe para impedir, reintroduzido pela denormalização.
 */
export type AdScoreDenormalization = {
  adId: string;
  currentScoreId: string;
  currentAiScore: number;
  currentScoreConfidence: number;
  currentScoreCoverage: number;
  scoreDelta7d: number | null;
  scoreAsOf: Date;
};

/**
 * A narrativa, gravada **depois** e por cima da linha que já existe (P4).
 *
 * Escrita separada de `appendMany` de propósito: o score precisa estar
 * persistido antes de qualquer LLM ser chamado, para que provider fora do ar,
 * plano sem a feature ou teto estourado deixem o número intacto e apenas o
 * texto ausente. Juntá-los num insert só faria a falha de IA levar o score
 * embora — exatamente o que P4 proíbe.
 */
export type AdScoreNarrativeWrite = {
  /** O id devolvido por `appendMany`, não o do anúncio. */
  scoreId: string;
  narrative: string;
  provider: string;
  model: string;
};

export abstract class AdScoresRepositoryInterface {
  /** Grava as linhas novas. Devolve `adId → id` do score gravado. */
  abstract appendMany(scores: AdScoreWrite[]): Promise<Map<string, string>>;

  /** Anexa as narrativas geradas às linhas já persistidas. */
  abstract attachNarratives(narratives: AdScoreNarrativeWrite[]): Promise<void>;

  /**
   * O digest da última execução por anúncio, na versão ativa.
   *
   * É o que torna P9 executável: sem mudança de digest, o dia seguinte não
   * recomputa nem chama LLM. Sem esta leitura, "o custo marginal de analisar um
   * anúncio é limitado" seria uma intenção sem mecanismo.
   */
  abstract lastDigestByAd(input: {
    organizationId: string;
    adIds: string[];
    algoVersion: string;
  }): Promise<Map<string, string>>;

  /**
   * O score de N dias atrás, para o delta — **por linhagem**, não por `adId`:
   * recriar o anúncio não pode recomeçar o histórico de saúde do zero (§3.6).
   *
   * **`notBefore` é o piso da base, e sem ele o delta mentia.**
   *
   * A busca é "o mais recente em ou antes de `date`", e sem piso ela aceitava
   * qualquer coisa: um score de trinta dias atrás virava base de um campo
   * chamado `delta7d`. Enquanto todo anúncio era pontuado toda noite isso era
   * teórico. Com o rodízio da varredura passou a ser o caso comum — um anúncio
   * pontuado a cada onze noites teria "queda de 7 dias" medida sobre onze,
   * vinte e dois ou trinta e três, e `AD_SCORE_DROPPED` dispararia em cima de um
   * artefato do escopo, não da mídia.
   *
   * Fora da janela devolve **ausência**, e ausência já significa "não há delta a
   * alertar" para quem chama.
   */
  abstract scoreAtOrBefore(input: {
    organizationId: string;
    lineageIds: string[];
    date: Date;
    notBefore: Date;
    algoVersion: string;
  }): Promise<Map<string, { aiScore: number; scoreDate: Date }>>;

  /**
   * Se o último score de cada anúncio foi calculado sobre **proxy** (§12.2).
   *
   * É o que permite derivar a chegada dos sinais reais por anúncio, em vez de
   * por flag de release: a plataforma libera `hides`/`reports` quando quer — por
   * conta, por volume, por região —, e não no dia em que o código sobe. Uma flag
   * global marcaria descontinuidade em anúncios que continuam sem sinal nenhum.
   */
  abstract proxyBasedByAd(input: {
    organizationId: string;
    adIds: string[];
    algoVersion: string;
  }): Promise<Map<string, boolean>>;

  abstract denormalizeIntoAds(updates: AdScoreDenormalization[]): Promise<void>;
}
