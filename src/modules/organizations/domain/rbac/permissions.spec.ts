import { ORGANIZATION_ROLES, OrganizationRole, rankOf } from './roles';
import { Permission, ROLE_PERMISSIONS, roleHasPermission } from './permissions';

const ACTION_PERMISSIONS: Permission[] = [
  'actions:read',
  'actions:execute',
  'actions:execute_sensitive',
  'actions:consent_manage',
  'actions:kill_switch',
];

describe('platform-write permissions', () => {
  /**
   * The regression this whole matrix exists to prevent. FINANCE outranks
   * ANALYST (60 > 40), so any authorization written as `rank >= ANALYST` would
   * let the billing seat pause ads and change budgets. Capability and hierarchy
   * are separate axes, and this test is what keeps them separate.
   */
  it('denies FINANCE every platform-write permission despite outranking ANALYST', () => {
    expect(rankOf('FINANCE')).toBeGreaterThan(rankOf('ANALYST'));

    for (const permission of ACTION_PERMISSIONS) {
      expect(roleHasPermission('FINANCE', permission)).toBe(false);
    }
  });

  it('keeps FINANCE the only non-OWNER role holding billing:manage', () => {
    const holders = ORGANIZATION_ROLES.filter((role) =>
      roleHasPermission(role, 'billing:manage'),
    );

    expect(holders.sort()).toEqual(['FINANCE', 'OWNER']);
  });

  it('lets ANALYST execute ordinary writes but never sensitive ones', () => {
    expect(roleHasPermission('ANALYST', 'actions:execute')).toBe(true);
    expect(roleHasPermission('ANALYST', 'actions:execute_sensitive')).toBe(
      false,
    );
  });

  /**
   * Before platform writes existed, MEMBER and ANALYST were byte-identical.
   * This is the difference that gives the two roles a reason to both exist.
   */
  it('lets MEMBER read the action surface without executing anything', () => {
    expect(roleHasPermission('MEMBER', 'actions:read')).toBe(true);
    expect(roleHasPermission('MEMBER', 'actions:execute')).toBe(false);
    expect(roleHasPermission('MEMBER', 'actions:execute_sensitive')).toBe(
      false,
    );
  });

  it('keeps VIEWER out of the action surface entirely', () => {
    for (const permission of ACTION_PERMISSIONS) {
      expect(roleHasPermission('VIEWER', permission)).toBe(false);
    }
  });

  it('gives ADMIN and OWNER the sensitive tier, consent and the kill switch', () => {
    for (const role of ['OWNER', 'ADMIN'] as OrganizationRole[]) {
      for (const permission of ACTION_PERMISSIONS) {
        expect(roleHasPermission(role, permission)).toBe(true);
      }
    }
  });

  /**
   * Consent (§13.5) is the record of who authorized Allva to write on a
   * platform, and the kill switch is what stops every write at once. Neither is
   * an ad-management task — they are org governance, and they stay above the
   * roles that merely run campaigns.
   */
  it('reserves consent and kill switch to roles that cannot also be granted casually', () => {
    for (const role of ['FINANCE', 'ANALYST', 'MEMBER', 'VIEWER'] as const) {
      expect(roleHasPermission(role, 'actions:consent_manage')).toBe(false);
      expect(roleHasPermission(role, 'actions:kill_switch')).toBe(false);
    }
  });
});

describe('permission matrix integrity', () => {
  it('never grants a permission outside the declared union', () => {
    const declared = new Set<string>(Object.values(ROLE_PERMISSIONS).flat());

    for (const permission of declared) {
      expect(typeof permission).toBe('string');
      expect(permission).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('never lists the same permission twice for a role', () => {
    for (const role of ORGANIZATION_ROLES) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size).toBe(granted.length);
    }
  });

  /**
   * Not a hierarchy assertion — a containment one, and only where the product
   * actually intends it. OWNER is defined as the full set, so anything a lesser
   * role holds it must hold too; a permission escaping this is a permission
   * OWNER cannot audit.
   */
  it('makes OWNER a superset of every other role', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(roleHasPermission('OWNER', permission)).toBe(true);
      }
    }
  });
});
