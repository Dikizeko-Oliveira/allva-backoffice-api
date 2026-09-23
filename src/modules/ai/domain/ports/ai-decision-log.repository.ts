import type { AiCallOutcome } from 'src/modules/ai/domain/ai-budget';

/**
 * O registro de toda decisão de IA (C9, §17.1).
 *
 * Uma linha por chamada — **e por chamada que não aconteceu**. `SKIPPED_BUDGET`
 * e `SKIPPED_DIGEST` existem porque economia sem registro é indistinguível de
 * bug: sem eles, "a narrativa sumiu" tem duas explicações possíveis e nenhuma
 * forma de escolher entre elas.
 */
export type AiDecisionRecord = {
  organizationId: string;
  adId?: string | null;
  creativeUploadId?: string | null;
  recommendationId?: string | null;

  taskType: string;
  /**
   * Separado de `model` porque o roteamento é multi-provider: o benchmark de
   * custo precisa saber **quem de fato atendeu**, não quem foi pedido.
   */
  provider: string;
  model: string;
  promptVersion: string;

  outcome: AiCallOutcome;
  /**
   * O que impede o benchmark de custo-por-modelo de errar justamente nas
   * chamadas que caíram para o secundário — que são as interessantes.
   */
  fallbackUsed: boolean;

  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  costBase?: number | null;
  /**
   * A taxa USD → moeda-base que produziu `costBase`.
   *
   * Vem do próprio veredito de `costBaseOf`, e não de uma segunda leitura da
   * configuração: entre converter e gravar, a moeda-base da organização ou a
   * env podem mudar, e o log passaria a afirmar uma taxa que não foi a usada.
   *
   * Sem ela o custo histórico é irreconstituível — um lançamento de R$ 0,0016
   * não diz se usou 5,5 ou 6,2 —, e atualizar a taxa reescreveria a leitura do
   * passado inteiro.
   */
  usdToBaseRate?: number | null;

  /** Torna P9 auditável por query: "houve chamada sem mudança de digest?" */
  inputDigest?: string | null;

  /**
   * Conteúdo de marca do cliente e volume alto: **hash sempre**, texto só atrás
   * de flag e com retenção curta.
   */
  promptHash: string;
  responseText?: string | null;
  errorPayload?: Record<string, unknown> | null;
  correlationId?: string | null;
};

export abstract class AiDecisionLogRepositoryInterface {
  abstract record(entry: AiDecisionRecord): Promise<void>;

  /**
   * Quanto a organização já gastou com IA no dia, em moeda-base.
   *
   * Só as chamadas que de fato aconteceram entram: somar `SKIPPED_*` faria o
   * teto se esgotar com economia, que é o oposto do que ele mede.
   */
  abstract spentTodayBase(input: {
    organizationId: string;
    day: Date;
  }): Promise<number>;
}
