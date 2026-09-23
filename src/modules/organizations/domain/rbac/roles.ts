export type OrganizationRole =
  | 'OWNER'
  | 'ADMIN'
  | 'FINANCE'
  | 'ANALYST'
  | 'MEMBER'
  | 'VIEWER';

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  'OWNER',
  'ADMIN',
  'FINANCE',
  'ANALYST',
  'MEMBER',
  'VIEWER',
] as const;

/**
 * Privilege ranking used for authorization comparisons. A higher rank means
 * more privilege. The core anti-escalation rule is: an actor may only act on
 * (remove / change role / change status of) a target whose rank is strictly
 * lower than the actor's own, and may never grant a role with rank >= their own.
 */
export const ROLE_RANK: Record<OrganizationRole, number> = {
  OWNER: 100,
  ADMIN: 80,
  FINANCE: 60,
  ANALYST: 40,
  MEMBER: 20,
  VIEWER: 10,
};

export function rankOf(role: OrganizationRole): number {
  return ROLE_RANK[role];
}

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}
