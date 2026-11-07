/**
 * As regras de SLA do atendimento — funções puras, sem banco e sem relógio
 * implícito (`now` é sempre parâmetro).
 */

export const SLA_STATES = ['BREACHED', 'AT_RISK', 'ON_TRACK'] as const;
export type SlaState = (typeof SLA_STATES)[number];

/**
 * Quanto antes do vencimento um prazo passa a contar como "em risco": a última
 * quarta parte do prazo, nunca menos de 10 minutos nem mais de 2 horas.
 *
 * Era uma janela fixa de 2 horas (GAP-059). Com ela, a primeira resposta de um
 * HIGH (2 h) e a de um CRITICAL (30 min) nasciam "em risco": o contador do hub
 * mostrava todo chamado urgente recém-aberto como risco, e o sinal deixava de
 * distinguir o que está apertado do que acabou de chegar. Proporcional, um
 * HIGH novo está no prazo e entra em risco nos últimos 30 minutos; o teto de
 * 2 h mantém o comportamento antigo para os prazos longos (LOW, MEDIUM,
 * resolução) e é também o horizonte máximo que a contagem do hub consulta.
 */
export const SLA_AT_RISK_SHARE = 0.25;
export const SLA_AT_RISK_MIN_WINDOW_MS = 10 * 60 * 1000;
export const SLA_AT_RISK_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Um prazo ainda pendente e o instante em que ele começou a correr. */
export type PendingDeadline = { dueAt: Date; startedAt: Date };

export function slaAtRiskWindowMs(deadline: PendingDeadline): number {
  const durationMs = deadline.dueAt.getTime() - deadline.startedAt.getTime();
  const proportional = Math.max(0, durationMs) * SLA_AT_RISK_SHARE;

  return Math.min(
    SLA_AT_RISK_MAX_WINDOW_MS,
    Math.max(SLA_AT_RISK_MIN_WINDOW_MS, proportional),
  );
}

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

type SnapshotDeadlines = {
  status: string;
  openedAt: Date;
  dueFirstResponseAt: Date | null;
  dueResolutionAt: Date | null;
  firstOperatorReplyAt: Date | null;
};

/**
 * Os prazos que ainda correm num chamado: a primeira resposta enquanto nenhum
 * operador respondeu, a resolução enquanto o chamado está vivo. Os dois contam
 * a partir da abertura. É a mesma regra para a fila (`slaView`) e para a
 * contagem do hub — por isso mora aqui, e não em cada um.
 */
export function pendingDeadlinesOf(
  snapshot: SnapshotDeadlines,
): PendingDeadline[] {
  if (!isLiveTicketStatus(snapshot.status)) return [];

  const dues = [
    snapshot.firstOperatorReplyAt ? null : snapshot.dueFirstResponseAt,
    snapshot.dueResolutionAt,
  ];

  return dues
    .filter((due): due is Date => due !== null)
    .map((dueAt) => ({ dueAt, startedAt: snapshot.openedAt }));
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
  pending: readonly PendingDeadline[],
  now: Date,
): SlaState {
  const nowMs = now.getTime();

  if (pending.some(({ dueAt }) => dueAt.getTime() < nowMs)) return 'BREACHED';

  if (
    pending.some(
      (deadline) =>
        deadline.dueAt.getTime() <= nowMs + slaAtRiskWindowMs(deadline),
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
