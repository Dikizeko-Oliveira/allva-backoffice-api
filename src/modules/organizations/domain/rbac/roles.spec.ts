import {
  ORGANIZATION_ROLES,
  OrganizationRole,
  isOrganizationRole,
  rankOf,
} from './roles';

// The core anti-escalation rule the org use cases rely on: an actor may only
// act on a target of strictly lower rank, and may never grant a role whose rank
// is >= their own. These helpers express that invariant purely in terms of rank.
function canActOn(actor: OrganizationRole, target: OrganizationRole): boolean {
  return rankOf(actor) > rankOf(target);
}
function canGrant(actor: OrganizationRole, role: OrganizationRole): boolean {
  return rankOf(role) < rankOf(actor);
}

describe('organization role hierarchy', () => {
  it('orders roles from OWNER (highest) down to VIEWER (lowest)', () => {
    const ordered = [...ORGANIZATION_ROLES].sort(
      (a, b) => rankOf(b) - rankOf(a),
    );
    expect(ordered).toEqual([
      'OWNER',
      'ADMIN',
      'FINANCE',
      'ANALYST',
      'MEMBER',
      'VIEWER',
    ]);
  });

  it('gives every role a distinct rank', () => {
    const ranks = ORGANIZATION_ROLES.map(rankOf);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('makes OWNER outrank every other role', () => {
    for (const role of ORGANIZATION_ROLES.filter((r) => r !== 'OWNER')) {
      expect(rankOf('OWNER')).toBeGreaterThan(rankOf(role));
    }
  });

  it('guards unknown role strings', () => {
    expect(isOrganizationRole('ADMIN')).toBe(true);
    expect(isOrganizationRole('SUPERUSER')).toBe(false);
    expect(isOrganizationRole('')).toBe(false);
  });
});

describe('anti-escalation invariant', () => {
  it('forbids acting on a peer or higher-ranked member', () => {
    expect(canActOn('ADMIN', 'ADMIN')).toBe(false);
    expect(canActOn('ADMIN', 'OWNER')).toBe(false);
    expect(canActOn('ADMIN', 'MEMBER')).toBe(true);
  });

  it('forbids granting a role at or above the actor', () => {
    expect(canGrant('ADMIN', 'OWNER')).toBe(false);
    expect(canGrant('ADMIN', 'ADMIN')).toBe(false);
    expect(canGrant('ADMIN', 'ANALYST')).toBe(true);
  });

  it('never lets a non-owner escalate anyone to OWNER', () => {
    for (const actor of ORGANIZATION_ROLES.filter((r) => r !== 'OWNER')) {
      expect(canGrant(actor, 'OWNER')).toBe(false);
    }
  });
});
