import type { AdActionType } from './platform-profile';

/**
 * **Como a plataforma aplica a mudança** — e nada além disso.
 *
 * Existia antes como o booleano `requiresRecreate`, que respondia duas
 * perguntas ao mesmo tempo: *"a plataforma cria um recurso novo?"* e *"isto
 * atrapalha a entrega?"*. As duas são independentes, e tratá-las como uma só
 * fazia o Recommendation Engine, a linhagem e a auditoria decidirem sobre uma
 * premissa errada — na Meta, trocar o criativo mantém o `ad_id` e ainda assim
 * reinicia o aprendizado.
 *
 * Agora a estratégia responde à primeira pergunta e `ActionImpact` à segunda.
 */
export type MutationStrategy =
  /** Mesmo recurso, mesmo id: a plataforma edita em lugar. */
  | 'PATCH'
  /**
   * Recurso novo **substitui** o antigo: o id muda e o gasto migra. É o único
   * caso que produz sucessor, e portanto o único que herda linhagem (§3.6).
   */
  | 'RECREATE'
  /**
   * Recurso novo **ao lado** do antigo, que continua veiculando. Cria entidade
   * sem substituir nada, e por isso começa a própria linhagem.
   */
  | 'DUPLICATE';

/**
 * O que a mudança faz com a entrega — independente de como ela é aplicada.
 *
 * `changesResourceId` é derivado da estratégia; os outros dois **não são**, e é
 * exatamente por isso que precisam ser declarados. Uma edição em lugar pode
 * reiniciar o aprendizado, e uma duplicação não reinicia o de ninguém.
 */
export type ActionImpact = {
  /** O anúncio volta à fase de aprendizado da plataforma. */
  resetsLearning: boolean;
  /** Curtidas, comentários e compartilhamentos acumulados se perdem. */
  losesSocialProof: boolean;
  /** O id do recurso muda — verdadeiro apenas em `RECREATE`. */
  changesResourceId: boolean;
};

export type ActionMutation = {
  strategy: MutationStrategy;
  resetsLearning?: boolean;
  losesSocialProof?: boolean;
};

/** Ausência de declaração é `PATCH` sem impacto: mudar status não recria nada. */
export const DEFAULT_MUTATION: ActionMutation = { strategy: 'PATCH' };

export function impactOf(mutation: ActionMutation): ActionImpact {
  return {
    resetsLearning: mutation.resetsLearning ?? false,
    losesSocialProof: mutation.losesSocialProof ?? false,
    changesResourceId: mutation.strategy === 'RECREATE',
  };
}

export type MutationByAction = Partial<Record<AdActionType, ActionMutation>>;
