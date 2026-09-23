/**
 * As regras de SLA do atendimento — funções puras, sem banco e sem relógio
 * implícito (`now` é sempre parâmetro).
 */

export const SLA_STATES = ['BREACHED', 'AT_RISK', 'ON_TRACK'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/** Quanto antes do vencimento um chamado passa a contar como "em risco". */
export const SLA_AT_RISK_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Status do produto em que o chamado ainda espera alguém da Allva. */
export const LIVE_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

export function isLiveTicketStatus(status: string): boolean {
  return (LIVE_TICKET_STATUSES as readonly string[]).includes(status);
}

export type SlaTargets = {
  firstResponseMinutes: number;
  resolutionMinutes: number;
};

/**
 * Metas usadas quando nenhuma política ativa cobre a prioridade. Existem para
 * que a fila nunca fique sem prazo só porque ninguém cadastrou política ainda —
 * e são conservadoras: o crítico em 30 minutos, o baixo em um dia.
 */
export const FALLBACK_SLA_TARGETS: Readonly<Record<string, SlaTargets>> = {
  LOW: { firstResponseMinutes: 24 * 60, resolutionMinutes: 5 * 24 * 60 },
  MEDIUM: { firstResponseMinutes: 8 * 60, resolutionMinutes: 3 * 24 * 60 },
  HIGH: { firstResponseMinutes: 2 * 60, resolutionMinutes: 24 * 60 },
  CRITICAL: { firstResponseMinutes: 30, resolutionMinutes: 4 * 60 },
};

export function fallbackSlaTargets(priority: string): SlaTargets {
  return FALLBACK_SLA_TARGETS[priority] ?? FALLBACK_SLA_TARGETS.MEDIUM;
}

type PolicyLike = {
  priority: string;
  category: string | null;
  active: boolean;
} & SlaTargets;

/**
 * A política que vale para um chamado: a da prioridade **e** categoria, senão
 * a genérica da prioridade (`category: null`), senão o fallback.
 */
export function resolveSlaTargets(
  policies: readonly PolicyLike[],
  priority: string,
  category: string | null,
): SlaTargets {
  const candidates = policies.filter(
    (policy) => policy.active && policy.priority === priority,
  );
  const policy =
    candidates.find(
      (candidate) => category !== null && candidate.category === category,
    ) ?? candidates.find((candidate) => candidate.category === null);

  if (!policy) return fallbackSlaTargets(priority);

  return {
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
  };
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * O estado a partir dos prazos **ainda pendentes**. Prazo cumprido (primeira
 * resposta dada, chamado resolvido) não entra: um chamado encerrado com atraso
 * não continua "estourado" na fila para sempre.
 */
export function slaStateOf(
  pendingDueDates: readonly Date[],
  now: Date,
): SlaState {
  const nowMs = now.getTime();

  if (pendingDueDates.some((due) => due.getTime() < nowMs)) return 'BREACHED';

  if (
    pendingDueDates.some(
      (due) => due.getTime() <= nowMs + SLA_AT_RISK_WINDOW_MS,
    )
  ) {
    return 'AT_RISK';
  }

  return 'ON_TRACK';
}

/**
 * Posição na fila: menor é mais urgente. Estourado primeiro, depois em risco,
 * depois o resto — é a ordem de `SLA_STATES`.
 */
export function slaUrgencyOrder(state: SlaState): number {
  return SLA_STATES.indexOf(state);
}
