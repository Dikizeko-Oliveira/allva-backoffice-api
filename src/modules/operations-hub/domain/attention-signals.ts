import type { PlatformPermission } from 'src/modules/auth/domain/platform-permissions';

/**
 * O "Requires attention" do processo interno — a metade do hub que o
 * `allva-api` não conhece (`docs/backoffice-api.md` §3.2). A web junta estes
 * sinais com os de `GET /api/v1/admin/attention` e casa cada um com o item de
 * navegação que exige a mesma permissão.
 */

export const ATTENTION_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export function isAttentionSeverity(value: string): value is AttentionSeverity {
  return (ATTENTION_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Os sinais de atendimento, em ordem de catálogo. A ordem importa: dentro da
 * mesma severidade, é ela que decide quem aparece primeiro.
 */
export const SUPPORT_ATTENTION_SIGNALS = [
  /** Prazo de primeira resposta ou de resolução já vencido. */
  {
    key: 'support.sla_breached',
    permission: 'support:read',
    severity: 'CRITICAL',
  },
  /** Vence nas próximas duas horas. */
  {
    key: 'support.sla_at_risk',
    permission: 'support:read',
    severity: 'WARNING',
  },
  /** Escalonado e ninguém reconheceu o escalonamento. */
  {
    key: 'support.escalated',
    permission: 'support:read',
    severity: 'WARNING',
  },
  /** Chamados do próprio operador em que o cliente falou por último. */
  {
    key: 'support.assigned_to_me_waiting',
    permission: 'support:read',
    severity: 'INFO',
  },
] as const satisfies readonly {
  key: string;
  permission: PlatformPermission;
  severity: AttentionSeverity;
}[];

export type SupportAttentionSignal = (typeof SUPPORT_ATTENTION_SIGNALS)[number];
export type SupportAttentionKey = SupportAttentionSignal['key'];

/**
 * Alertas internos não reconhecidos. Um sinal por par permissão + severidade:
 * a regra de alerta declara a permissão de quem pode vê-lo, então o mesmo
 * alerta cai em áreas diferentes conforme a regra.
 */
export const UNACKNOWLEDGED_ALERTS_KEY = 'alerts.unacknowledged';

export function supportSignalsVisibleTo(
  can: (permission: string) => boolean,
): SupportAttentionSignal[] {
  return SUPPORT_ATTENTION_SIGNALS.filter((signal) => can(signal.permission));
}

export function severityOrder(severity: AttentionSeverity): number {
  return ATTENTION_SEVERITIES.indexOf(severity);
}
