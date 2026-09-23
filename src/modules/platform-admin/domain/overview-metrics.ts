import type { PlatformPermission } from 'src/modules/accounts/domain/platform-rbac';
import type { OverviewMetricKey } from './read-models';

/**
 * Os números do Dashboard do backoffice, cada um sob a permissão da área que
 * o responde.
 *
 * Mesmo desenho do "Requires attention" (`operations-hub`): o operador só
 * recebe as métricas cuja permissão tem, e a consulta das outras não roda. O
 * Dashboard do financeiro mostra receita e inadimplência; o do suporte,
 * chamados — sem uma linha de código que pergunte o papel.
 *
 * A diferença para o hub é a natureza do número: lá é "o que espera por
 * você" (pede ação), aqui é "como está a plataforma" (contexto).
 */
export type OverviewMetricUnit = 'COUNT' | 'MONEY';

export type OverviewMetricDefinition = {
  key: OverviewMetricKey;
  permission: PlatformPermission;
  unit: OverviewMetricUnit;
};

export const OVERVIEW_METRICS: readonly OverviewMetricDefinition[] = [
  { key: 'orgs.total', permission: 'orgs:read', unit: 'COUNT' },
  { key: 'orgs.active', permission: 'orgs:read', unit: 'COUNT' },
  { key: 'orgs.trialing', permission: 'orgs:read', unit: 'COUNT' },
  { key: 'orgs.past_due', permission: 'subscriptions:read', unit: 'COUNT' },
  {
    key: 'billing.monthly_recurring',
    permission: 'billing:read',
    unit: 'MONEY',
  },
  { key: 'billing.overdue_amount', permission: 'billing:read', unit: 'MONEY' },
  { key: 'support.tickets_open', permission: 'support:read', unit: 'COUNT' },
  { key: 'leads.new_30d', permission: 'leads:read', unit: 'COUNT' },
  { key: 'contacts.new_7d', permission: 'contacts:read', unit: 'COUNT' },
  {
    key: 'integrations.connected',
    permission: 'integrations:read',
    unit: 'COUNT',
  },
  {
    key: 'integrations.unhealthy',
    permission: 'integrations:read',
    unit: 'COUNT',
  },
  {
    key: 'operations.job_runs_failed_24h',
    permission: 'operations:read',
    unit: 'COUNT',
  },
];

export function metricsVisibleTo(
  permissions: readonly PlatformPermission[],
): OverviewMetricDefinition[] {
  const granted = new Set(permissions);
  return OVERVIEW_METRICS.filter((metric) => granted.has(metric.permission));
}
