/**
 * A máquina de estados de `syncState` (§3.5, invariante I4).
 *
 * Estado de sincronização é a única coisa que o usuário tem para saber se o que
 * a tela mostra ainda é verdade. Transição livre — cada módulo atribuindo o
 * estado que lhe convém — é como o produto passa a dizer "em dia" sobre um
 * anúncio que ninguém lê há três dias.
 *
 * Duas regras, e a segunda é a que costuma faltar: **a transição é válida ou
 * não** (o grafo abaixo), e **quem a faz tem de estar autorizado** (a tabela de
 * §3.5). `platform-actions` pode levar a `PENDING_WRITE` e nada mais; todo o
 * resto é do `sync`.
 */
export type AdSyncState =
  | 'IN_SYNC'
  | 'PENDING_WRITE'
  | 'DRIFTED'
  | 'STALE'
  | 'UNREACHABLE';

/** Quem tem autoridade para transicionar. Um módulo, nunca "o sistema". */
export type SyncStateActor = 'sync' | 'platform-actions';

export type SyncStateTransition = {
  from: AdSyncState;
  to: AdSyncState;
  actor: SyncStateActor;
};

/**
 * O grafo de §3.5.
 *
 * `sync` pode levar qualquer estado a `IN_SYNC`, `STALE`, `DRIFTED` ou
 * `UNREACHABLE` — ele é quem observa a plataforma, e observação pode contradizer
 * qualquer expectativa nossa.
 *
 * `platform-actions` só pode a transição que lhe cabe: `IN_SYNC | STALE →
 * PENDING_WRITE`. Notar o que **não** está aqui: ele não pode sair de
 * `PENDING_WRITE`. Quem confirma que a escrita chegou é quem lê a plataforma —
 * deixar o escritor declarar o próprio sucesso é como o produto reportaria
 * "pausado" para um anúncio que a plataforma recusou.
 */
const SYNC_TRANSITIONS: Record<
  SyncStateActor,
  Partial<Record<AdSyncState, AdSyncState[]>>
> = {
  sync: {
    IN_SYNC: ['IN_SYNC', 'STALE', 'DRIFTED', 'UNREACHABLE'],
    PENDING_WRITE: ['IN_SYNC', 'DRIFTED', 'UNREACHABLE'],
    DRIFTED: ['IN_SYNC', 'STALE', 'DRIFTED', 'UNREACHABLE'],
    STALE: ['IN_SYNC', 'STALE', 'DRIFTED', 'UNREACHABLE'],
    UNREACHABLE: ['IN_SYNC', 'STALE', 'DRIFTED', 'UNREACHABLE'],
  },
  'platform-actions': {
    IN_SYNC: ['PENDING_WRITE'],
    STALE: ['PENDING_WRITE'],
  },
};

export type TransitionVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Decide uma transição. Função pura: sem I/O, sem relógio, sem entidade.
 *
 * Devolve o motivo quando recusa porque o motivo vai para o log e para o teste —
 * "transição inválida" sem dizer qual não ajuda ninguém a às 3h da manhã.
 */
export function canTransition(
  transition: SyncStateTransition,
): TransitionVerdict {
  const allowedTargets = SYNC_TRANSITIONS[transition.actor][transition.from];

  if (!allowedTargets) {
    return {
      allowed: false,
      reason: `${transition.actor} não pode transicionar a partir de ${transition.from}`,
    };
  }

  if (!allowedTargets.includes(transition.to)) {
    return {
      allowed: false,
      reason: `${transition.actor} não pode levar ${transition.from} para ${transition.to}`,
    };
  }

  return { allowed: true };
}

export class InvalidSyncStateTransitionError extends Error {
  constructor(
    readonly transition: SyncStateTransition,
    reason: string,
  ) {
    super(`Transição de syncState inválida: ${reason}`);
    this.name = 'InvalidSyncStateTransitionError';
  }
}

/**
 * Aplica a transição ou levanta. É o único caminho de escrita de `syncState`
 * (I4): nenhuma atribuição direta em repositório ou use case.
 */
export function transitionSyncState(
  transition: SyncStateTransition,
): AdSyncState {
  const verdict = canTransition(transition);
  if (!verdict.allowed) {
    throw new InvalidSyncStateTransitionError(transition, verdict.reason);
  }

  return transition.to;
}

/**
 * Quando o estado indica que o número na tela pode não descrever a plataforma.
 *
 * `PENDING_WRITE` conta como não-confiável de propósito: a UI deve mostrar
 * "pausando…", não "pausado" — a plataforma pode levar minutos, ou recusar.
 */
export function isStaleForDisplay(state: AdSyncState): boolean {
  return state !== 'IN_SYNC';
}
