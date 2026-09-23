import type { CopyGenerationContext } from '../schemas/copy-generation.schema';
import type { CurrentCopy } from '../creative-suggestions';

/**
 * O que a geração de copy precisa ler e gravar.
 *
 * A leitura de contexto é **própria** e não reusa `subjectFor` da análise, e a
 * diferença é o que ela busca: objetivo de campanha e meta de otimização do
 * conjunto, que situam a oferta e o público e que a análise não olha. Espremer
 * os dois usos no mesmo `select` faria toda análise pagar por dois joins que ela
 * não usa — e a análise roda no ciclo noturno, a geração roda por clique.
 */

export type CopySubject = {
  adId: string;
  adName: string;
  platform: string;
  accountId: string;
  creativeId: string | null;
  /** `creatives.format` — decide se cada campo é aplicável **neste** anúncio. */
  creativeFormat: string | null;
  copy: CurrentCopy;
  landingPageUrl: string | null;
  /** O objetivo declarado na plataforma — não o que o usuário escolheu. */
  campaignObjective: string | null;
  /** Proxy de público: o que a plataforma expõe sem tocar em segmentação. */
  optimizationGoal: string | null;
  /** O score corrente, para a procedência da geração. */
  currentScoreId: string | null;
};

export type PersistGenerationInput = {
  organizationId: string;
  accountId: string;
  adId: string;
  creativeId: string | null;
  analysisId: string | null;
  adScoreId: string | null;
  source: 'FROM_INSIGHT' | 'IMPROVE' | 'FROM_BRIEF';
  status: 'COMPLETED' | 'AI_UNAVAILABLE';
  context: CopyGenerationContext;
  inputDigest: string;
  engineVersion: string;
  promptVersion: string;
  aiProvider: string | null;
  aiModel: string | null;
  failureReason: string | null;
  retentionUntil: Date;
  variants: PersistVariantInput[];
};

export type PersistVariantInput = {
  angle: 'BENEFIT' | 'PAIN' | 'OUTCOME' | 'PROOF' | 'URGENCY';
  hook: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  callToAction: string | null;
  reasoning: unknown;
};

export type StoredVariant = PersistVariantInput & {
  id: string;
  selected: boolean;
  selectedAt: Date | null;
  appliedActionExecutionId: string | null;
  appliedAt: Date | null;
};

export type StoredGeneration = {
  id: string;
  adId: string;
  source: string;
  status: string;
  context: unknown;
  inputDigest: string;
  engineVersion: string;
  promptVersion: string;
  aiProvider: string | null;
  aiModel: string | null;
  failureReason: string | null;
  createdAt: Date;
  variants: StoredVariant[];
};

export abstract class CopyGenerationsRepositoryInterface {
  /** O anúncio, o criativo e o contexto de campanha que o prompt precisa. */
  abstract subjectFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<CopySubject | null>;

  /**
   * A última geração com o mesmo digest, se houver.
   *
   * **Não é P9.** P9 proíbe recomputo sem mudança de entrada porque o resultado
   * seria idêntico; aqui não seria — o modelo escreve outro texto a cada
   * chamada, e regerar é um pedido legítimo. O reuso existe para o duplo-clique
   * e para quem reabre a tela, e tem escape explícito (`regenerate`).
   */
  abstract findByDigest(input: {
    organizationId: string;
    adId: string;
    inputDigest: string;
  }): Promise<StoredGeneration | null>;

  abstract persist(input: PersistGenerationInput): Promise<StoredGeneration>;

  abstract findById(input: {
    organizationId: string;
    generationId: string;
  }): Promise<StoredGeneration | null>;

  /** O histórico do anúncio, mais recente primeiro. */
  abstract listForAd(input: {
    organizationId: string;
    adId: string;
    limit: number;
  }): Promise<StoredGeneration[]>;

  /**
   * Marca a variante escolhida — **uma por geração**.
   *
   * A exclusividade é resolvida aqui, numa transação, e não por índice parcial:
   * trocar de escolha é a operação comum, e um índice único obrigaria a
   * desmarcar antes de marcar em duas escritas que podem falhar no meio.
   */
  abstract select(input: {
    organizationId: string;
    variantId: string;
  }): Promise<StoredVariant | null>;

  /**
   * Carimba a variante que **de fato** foi ao ar.
   *
   * O casamento é por **dígito do texto**, não por "a selecionada do anúncio". A
   * distinção é o que impede a medição de mentir: R14 permite editar o texto
   * antes de confirmar, e um texto editado não é a variação — atribuí-la faria a
   * pergunta "o que a Allva sugeriu funcionou?" ser respondida com um texto que
   * a Allva não escreveu.
   *
   * Silencioso quando nada casa: a ação carregou texto que não veio daqui, e
   * isso é normal — `REPLACE_COPY` também aceita texto digitado à mão.
   */
  abstract linkApplied(input: {
    organizationId: string;
    adId: string;
    contentDigest: string;
    executionId: string;
    appliedAt: Date;
  }): Promise<void>;
}

/**
 * **Não há `latestSelectedForAd` aqui, e a ausência é deliberada.**
 *
 * A pergunta "qual variação está escolhida?" quem faz é `recommendations`, e ela
 * a faz para **N anúncios de uma vez**, no planejamento noturno. Um método por
 * anúncio produziria N consultas onde uma basta, e o repositório de alvos de lá
 * já lê criativo e achado direto pelo mesmo motivo.
 *
 * Um port declarado sem chamador é vocabulário morto — o mesmo achado que este
 * repositório já registrou em `AITaskType`.
 */
