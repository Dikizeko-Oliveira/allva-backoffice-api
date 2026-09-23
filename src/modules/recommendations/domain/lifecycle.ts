import type { RecommendationStatus } from './contracts/recommendation-catalog';

/**
 * Ciclo de vida das recomendações (C5, ⊕7, §9.4 passos 6 a 8).
 *
 * §16.16 é normativo: *"nenhum status não terminal sem caminho de saída"*. Três
 * dos quatro caminhos aqui são expiração; o quarto é o que ⊕7 encontrou faltando.
 *
 * > **`DEFERRED_BY_CONFLICT` é o único status não terminal sem caminho de saída
 * > declarado.** Quando a recomendação vencedora é aplicada ou expira, o conflito
 * > desaparece — mas a perdedora ficaria presa nesse estado para sempre, e o
 * > problema que ela descreve continua queimando dinheiro sem nunca voltar à
 * > tela.
 */

export type LifecycleCandidate = {
  id: string;
  status: RecommendationStatus;
  expiresAt: Date | null;
  /** Achados de origem: quantos vinculados e quantos ainda abertos. */
  linkedWasteItems: number;
  openWasteItems: number;
  /** Preenchido só em `DEFERRED_BY_CONFLICT`. */
  conflictWithId: string | null;
  /** Status da vencedora do conflito, quando há uma. */
  conflictWinnerStatus: RecommendationStatus | null;
};

export type LifecycleTransition = {
  id: string;
  to: Extract<RecommendationStatus, 'EXPIRED' | 'NEW'>;
  reason: string;
};

/** Status a partir dos quais ainda faz sentido transicionar. */
const NON_TERMINAL: RecommendationStatus[] = [
  'NEW',
  'ACKNOWLEDGED',
  'DEFERRED_BY_CONFLICT',
];

/**
 * Status em que a vencedora deixa de disputar o alvo.
 *
 * `APPLIED` e `FAILED` são desfechos: a escrita aconteceu ou não vai acontecer.
 * `APPLYING` **não** entra — há escrita em voo, e reabilitar a perdedora agora
 * criaria exatamente a corrida que a I2 existe para impedir.
 */
const CONFLICT_CLEARED: RecommendationStatus[] = [
  'APPLIED',
  'FAILED',
  'EXPIRED',
  'DISMISSED',
  'SUPERSEDED',
];

export function decideTransitions(
  candidates: LifecycleCandidate[],
  now: Date,
): LifecycleTransition[] {
  const transitions: LifecycleTransition[] = [];

  for (const candidate of candidates) {
    if (!NON_TERMINAL.includes(candidate.status)) continue;

    const transition = decideOne(candidate, now);
    if (transition) transitions.push(transition);
  }

  return transitions;
}

function decideOne(
  candidate: LifecycleCandidate,
  now: Date,
): LifecycleTransition | null {
  const expired = candidate.expiresAt !== null && candidate.expiresAt <= now;

  // §9.4 passo 7 — o problema acabou por outro caminho. A recomendação continua
  // correta sobre um mundo que não existe mais, e mantê-la na tela convida a
  // aplicar uma correção sobre um anúncio já corrigido.
  const premiseGone =
    candidate.linkedWasteItems > 0 && candidate.openWasteItems === 0;

  if (candidate.status === 'DEFERRED_BY_CONFLICT') {
    const conflictCleared =
      candidate.conflictWinnerStatus === null ||
      CONFLICT_CLEARED.includes(candidate.conflictWinnerStatus);

    if (!conflictCleared) return null;

    // §9.4 passo 8: conflito cessado **e** premissa vencida ⇒ `EXPIRED`.
    // Reabilitar aqui poria de volta na tela uma recomendação que já não
    // descreve nada.
    if (expired || premiseGone) {
      return {
        id: candidate.id,
        to: 'EXPIRED',
        reason: premiseGone
          ? 'O conflito cessou, mas os achados de origem já foram resolvidos.'
          : 'O conflito cessou depois de a evidência vencer.',
      };
    }

    return {
      id: candidate.id,
      to: 'NEW',
      reason:
        'O conflito no alvo cessou e a premissa continua válida: a recomendação volta à tela.',
    };
  }

  if (premiseGone) {
    return {
      id: candidate.id,
      to: 'EXPIRED',
      reason: 'Todos os achados que a originaram foram resolvidos.',
    };
  }

  if (expired) {
    return {
      id: candidate.id,
      to: 'EXPIRED',
      reason: 'A evidência que a sustentava venceu.',
    };
  }

  return null;
}
