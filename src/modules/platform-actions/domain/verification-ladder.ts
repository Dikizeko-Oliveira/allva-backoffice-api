import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import type { ObservedEntityState } from 'src/modules/platform-actions/domain/contracts/action-contracts';

/**
 * §13.4 / entrega 7 — **a escada de verificação.**
 *
 * `execute` respondeu *"a plataforma aceitou"*. Isso não é o mesmo que *"a
 * plataforma fez"*: a Meta aceita a chamada e aplica o efeito de forma
 * assíncrona, e há regras dela — revisão, política, orçamento de campanha — que
 * desfazem a mudança minutos depois. Perguntar uma vez só responderia sobre o
 * instante errado.
 *
 * Os degraus são desiguais de propósito. T+90 s pega o caso comum (a plataforma
 * já aplicou), e os seguintes cobrem o raro sem manter uma sondagem cara ligada:
 * quatro perguntas em duas horas, não uma por minuto. Uma escada linear com o
 * mesmo alcance custaria 120 leituras por escrita, e R4 é orçamento de chamadas.
 */
export const VERIFICATION_LADDER_MS: readonly number[] = [
  90_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

export type VerificationOutcome =
  /** Observado bate com o desejado: a escrita chegou. */
  | 'CONFIRMED'
  /** Observado é outra coisa: a plataforma desfez, ou alguém mexeu. */
  | 'DIVERGED'
  /** Não deu para ler agora — o degrau seguinte tenta de novo. */
  | 'INCONCLUSIVE'
  /**
   * A escada esgotou sem resposta. **Estado terminal, e é uma afirmação
   * honesta**: escrevemos, a plataforma aceitou, e nunca conseguimos confirmar.
   * Distinto de `DIVERGED`, que afirma que não pegou, e de `INCONCLUSIVE`, que
   * ainda espera.
   */
  | 'UNVERIFIED_WRITE';

/**
 * O próximo degrau, ou `null` quando a escada acabou.
 *
 * `attempt` é o número de verificações **já feitas**. Zero ⇒ primeiro degrau.
 */
export function nextVerificationDelayMs(attempt: number): number | null {
  return VERIFICATION_LADDER_MS[attempt] ?? null;
}

export function ladderExhausted(attempt: number): boolean {
  return nextVerificationDelayMs(attempt) === null;
}

export type VerificationInput = {
  /** O que a ação pediu. `null` para ações que não mudam status (orçamento). */
  desiredStatus: AdStatus | null;
  /** O que a plataforma respondeu agora, ou `null` se a leitura falhou. */
  observed: ObservedEntityState | null;
  /** Mapeia o status cru da plataforma para o canônico. */
  toCanonical: (rawStatus: string) => AdStatus;
  /** Verificações já feitas, incluindo esta. */
  attempt: number;
};

/**
 * Compara o que se pediu com o que a plataforma mostra.
 *
 * **`DIVERGED` não reagenda.** Se o estado observado é outro estado definido, a
 * pergunta está respondida — insistir só produziria a mesma resposta quatro
 * vezes. Só `INCONCLUSIVE` sobe a escada, porque só ele significa "ainda não
 * sei".
 */
export function verifyWrite(input: VerificationInput): {
  outcome: VerificationOutcome;
  retryInMs: number | null;
} {
  if (!input.observed) {
    return exhaustOrRetry(input.attempt, 'INCONCLUSIVE');
  }

  /**
   * Ação sem estado desejado — orçamento — não tem o que comparar por status.
   * Ler a entidade com sucesso é toda a confirmação disponível aqui: o valor
   * numérico é reconferido pelo sync, que é quem tem a moeda da conta e sabe
   * converter a unidade menor sem adivinhar.
   */
  if (input.desiredStatus === null) {
    return { outcome: 'CONFIRMED', retryInMs: null };
  }

  if (!input.observed.status) {
    return exhaustOrRetry(input.attempt, 'INCONCLUSIVE');
  }

  const canonical = input.toCanonical(input.observed.status);

  if (canonical === input.desiredStatus) {
    return { outcome: 'CONFIRMED', retryInMs: null };
  }

  /**
   * `UNKNOWN` é status não mapeado, não estado divergente. Chamá-lo de
   * divergência afirmaria que a escrita não pegou com base em não sabermos ler a
   * resposta — e a plataforma acrescenta estados sem avisar.
   */
  if (canonical === 'UNKNOWN') {
    return exhaustOrRetry(input.attempt, 'INCONCLUSIVE');
  }

  return { outcome: 'DIVERGED', retryInMs: null };
}

function exhaustOrRetry(
  attempt: number,
  outcome: Extract<VerificationOutcome, 'INCONCLUSIVE'>,
): { outcome: VerificationOutcome; retryInMs: number | null } {
  const retryInMs = nextVerificationDelayMs(attempt);

  return retryInMs === null
    ? { outcome: 'UNVERIFIED_WRITE', retryInMs: null }
    : { outcome, retryInMs };
}
