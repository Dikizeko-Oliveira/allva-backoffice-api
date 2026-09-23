/**
 * O **vocabulário** das permissões de plataforma, espelhado do `allva-api`
 * (`src/modules/accounts/domain/platform-rbac.ts`).
 *
 * Só o vocabulário, nunca a matriz papel → permissão: essa continua sendo do
 * `allva-api`, e o operador chega aqui com `platformPermissions` já resolvidas
 * (`docs/backoffice-api.md` §1.4). A lista existe para o compilador recusar
 * `'billing:reed'` num use case; ela não filtra nada em tempo de execução, e
 * uma permissão nova que o `allva-api` passe a devolver continua chegando
 * intacta em `Operator.permissions`.
 *
 * Permissão nova nasce no `allva-api` primeiro, e só depois entra aqui.
 */
export const PLATFORM_PERMISSIONS = [
  'dashboard:read',
  'orgs:read',
  'orgs:manage',
  'orgs:quota_manage',
  'users:read',
  'users:manage',
  'users:manage_platform_role',
  'leads:read',
  'leads:manage',
  'support:read',
  'support:manage',
  'contacts:read',
  'contacts:manage',
  'subscriptions:read',
  'subscriptions:manage',
  'billing:read',
  'billing:manage',
  'integrations:read',
  'integrations:manage',
  'operations:read',
  'operations:execute',
  'audit:read',
  'settings:read',
  'settings:manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export function isPlatformPermission(
  value: string,
): value is PlatformPermission {
  return (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}
