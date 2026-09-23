import { OrganizationRole } from './roles';

export type Permission =
  | 'organization:read'
  | 'organization:update'
  | 'members:read'
  | 'members:invite'
  | 'members:remove'
  | 'members:update_role'
  | 'members:update_status'
  | 'integrations:read'
  | 'integrations:manage'
  | 'billing:read'
  | 'billing:manage'
  | 'analytics:read'
  | 'reports:read'
  // Platform writes (§13.5). Capability, never rank: see the note on
  // ROLE_PERMISSIONS below for why the distinction decides real money.
  | 'actions:read'
  | 'actions:execute'
  | 'actions:execute_sensitive'
  | 'actions:consent_manage'
  | 'actions:kill_switch';

const ALL_PERMISSIONS: Permission[] = [
  'organization:read',
  'organization:update',
  'members:read',
  'members:invite',
  'members:remove',
  'members:update_role',
  'members:update_status',
  'integrations:read',
  'integrations:manage',
  'billing:read',
  'billing:manage',
  'analytics:read',
  'reports:read',
  'actions:read',
  'actions:execute',
  'actions:execute_sensitive',
  'actions:consent_manage',
  'actions:kill_switch',
];

/**
 * Role -> permission matrix. The guard never trusts the client; every
 * permission decision is derived from the membership role resolved on the
 * server. OWNER holds every permission; other roles get a curated subset.
 *
 * **Capability, never rank.** ROLE_RANK exists for anti-escalation in
 * membership management — "may this actor act on that member" — and it answers
 * a question about hierarchy. Authorization asks a different question, and
 * reading "role >= ANALYST" as the answer would hand FINANCE (rank 60) the
 * power to pause ads and move budgets, because it outranks ANALYST (rank 40)
 * in a ladder that was never about ad writes. FINANCE is a billing seat: it
 * holds `billing:manage`, which no other non-OWNER role holds, and no
 * `actions:*` at all. The two axes are independent on purpose.
 *
 * The same separation gives MEMBER and ANALYST their first real difference:
 * both read, only ANALYST executes.
 */
export const ROLE_PERMISSIONS: Record<OrganizationRole, Permission[]> = {
  OWNER: [...ALL_PERMISSIONS],
  ADMIN: ALL_PERMISSIONS.filter((p) => p !== 'billing:manage'),
  FINANCE: [
    'organization:read',
    'members:read',
    'billing:read',
    'billing:manage',
    'analytics:read',
    'reports:read',
  ],
  ANALYST: [
    'organization:read',
    'members:read',
    'integrations:read',
    'analytics:read',
    'reports:read',
    'actions:read',
    'actions:execute',
  ],
  MEMBER: [
    'organization:read',
    'members:read',
    'integrations:read',
    'analytics:read',
    'reports:read',
    'actions:read',
  ],
  VIEWER: [
    'organization:read',
    'members:read',
    'analytics:read',
    'reports:read',
  ],
};

export function roleHasPermission(
  role: OrganizationRole,
  permission: Permission,
): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
