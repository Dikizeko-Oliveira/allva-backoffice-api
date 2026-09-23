import type { ComparableAd } from '../cross-ad-dispersion';
import type { CreativeCandidate } from '../creative-candidates';
import type { CurrentCopy, SuggestionSet } from '../creative-suggestions';
import type { SuggestionColumn } from '../schemas/creative-suggestions.schema';

/**
 * O que a análise do par `(Creative, Ad)` precisa ler e gravar (§11).
 *
 * **A unidade de análise é o par, não o criativo** (§3.4). O v1 pontuava o
 * criativo e produzia um número por ele; o mesmo criativo em cinco anúncios tem
 * cinco desempenhos, e a média não descreve nenhum. É por isso que toda leitura
 * aqui parte de um `adId` e não de um `creativeId`.
 */

export type AnalysisSubject = {
  adId: string;
  adSetId: string | null;
  adName: string;
  platform: string;
  creativeId: string;
  contentHash: string;
  /** Inclui o `contentHash`: é o que faz P9 valer para a análise criativa. */
  metricsDigest: string | null;
  accountId: string;
  adAccountId: string;
  /**
   * O texto que está no ar agora.
   *
   * Entra no `subject` e não numa leitura à parte porque as duas superfícies que
   * o consomem — as regras factuais de sugestão e o contexto da geração de copy
   * — precisam **do mesmo instante** que o resto da análise descreve. Uma
   * segunda consulta leria o criativo depois de uma sincronização no meio, e a
   * sugestão passaria a falar de um texto que não é o analisado.
   */
  copy: CurrentCopy;
};

export type PersistAnalysisInput = {
  organizationId: string;
  accountId: string;
  adId: string;
  creativeId: string;
  adScoreId: string | null;
  metricsDigest: string | null;
  trigger: 'MANUAL' | 'SCORE_UPDATED' | 'CREATIVE_CHANGED';
  engineVersion: string;
  diagnostics: unknown;
  candidates: unknown;
  /**
   * §11.4 passo 5 — **produzidas antes de qualquer chamada de IA**.
   *
   * A ordem importa e é a mesma da narrativa: o que é determinístico está
   * inteiro e gravado antes de o enriquecimento acontecer. É o que faz a
   * sugestão sobreviver a todos os provedores fora do ar.
   */
  suggestions: SuggestionSet;
  /** P4 — `null` quando a IA não pôde ou não deveria falar. Nunca desculpa. */
  narrative: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  startedAt: Date;
  completedAt: Date;
};

export type StoredAnalysis = {
  id: string;
  adId: string | null;
  creativeId: string;
  version: number;
  status: string;
  trigger: string;
  /** P9 — é a comparação deste campo que evita o recomputo sem mudança. */
  metricsDigest: string | null;
  diagnostics: unknown;
  candidates: unknown;
  /**
   * As quatro colunas já parseadas contra o schema versionado.
   *
   * Sai do repositório pronto para uso porque o caminho de **reuso** de P9
   * devolve a análise guardada sem recalcular nada: se o parse morasse no
   * presenter, a sugestão apareceria na análise nova e sumiria na reaproveitada
   * — e é justamente na reaproveitada que a pessoa reabre a tela.
   */
  suggestions: {
    hook: SuggestionColumn;
    body: SuggestionColumn;
    cta: SuggestionColumn;
    format: SuggestionColumn;
  };
  engineVersion: string;
  enrichedByAI: boolean;
  narrative: string | null;
  completedAt: Date | null;
};

export abstract class CreativeAnalysisRepositoryInterface {
  /** O anúncio, o criativo dele e as chaves que a análise precisa. */
  abstract subjectFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<AnalysisSubject | null>;

  /**
   * Os **outros** anúncios que rodam o mesmo criativo (§11.3).
   *
   * Sem score não entram: a comparação é entre desempenhos medidos, e um
   * anúncio sem score entraria como zero — puxando a mediana para baixo e
   * fabricando dispersão que não existe.
   */
  abstract adsOfCreative(input: {
    organizationId: string;
    creativeId: string;
  }): Promise<ComparableAd[]>;

  /** Criativos já veiculados na conta, com desempenho médio (§11.4). */
  abstract candidatesFor(input: {
    organizationId: string;
    adAccountId: string;
  }): Promise<CreativeCandidate[]>;

  /**
   * Grava a análise como versão nova, append-only.
   *
   * `version` incrementa por anúncio: a análise de ontem descreve o criativo de
   * ontem, e sobrescrevê-la apagaria a comparação que torna visível o efeito de
   * uma substituição.
   */
  abstract persist(input: PersistAnalysisInput): Promise<StoredAnalysis>;

  /** A última análise concluída de um anúncio, se houver. */
  abstract latestFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<StoredAnalysis | null>;
}
