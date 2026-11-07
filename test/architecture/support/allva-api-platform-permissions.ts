/**
 * Cópia versionada de `PLATFORM_PERMISSIONS` do `allva-api`
 * (`src/modules/accounts/domain/platform-rbac.ts`), tirada em 2026-11-06.
 *
 * O CI deste repositório não tem o `allva-api` ao lado, então o teste de
 * paridade compara o catálogo local com **esta** cópia — e, quando o
 * repositório irmão está presente (máquina de desenvolvimento, ou
 * `ALLVA_API_DIR` apontado para ele), compara também esta cópia com o arquivo
 * de lá. Permissão nova no `allva-api` entra aqui e no catálogo no mesmo
 * commit.
 */
export const ALLVA_API_PLATFORM_PERMISSIONS = [
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
  'beta:read',
  'beta:manage',
  'usage:read',
  'usage:manage',
] as const;
