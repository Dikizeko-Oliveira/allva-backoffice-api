import type { PlatformPermission } from 'src/modules/auth/domain/platform-permissions';

/**
 * As telas do backoffice-web que aceitam visão salva, e a permissão que cada
 * uma exige. Uma visão compartilhada de `payments` não pode aparecer para
 * quem não enxerga faturamento — nem o nome dela, que já diz muito ("Clientes
 * inadimplentes > 90 dias").
 */
export const SCREEN_PERMISSION: Readonly<Record<string, PlatformPermission>> = {
  dashboard: 'dashboard:read',
  organizations: 'orgs:read',
  users: 'users:read',
  leads: 'leads:read',
  support: 'support:read',
  contacts: 'contacts:read',
  subscriptions: 'subscriptions:read',
  payments: 'billing:read',
  integrations: 'integrations:read',
  operations: 'operations:read',
  audit: 'audit:read',
  operators: 'users:read',
  settings: 'settings:read',
};

export const SAVED_VIEW_SCREENS = Object.keys(SCREEN_PERMISSION);

export function screenPermission(screen: string): PlatformPermission | null {
  return SCREEN_PERMISSION[screen] ?? null;
}
