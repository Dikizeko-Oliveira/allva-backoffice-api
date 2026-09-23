import { CurrentOrganizationResolver } from './current-organization.resolver';

const ORG_A = { id: 'org-a', ownerId: 'account-1', name: 'Owned by me' };
const ORG_B = { id: 'org-b', ownerId: 'someone-else', name: 'I only admin it' };

function membership(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'membership-1',
    organizationId: ORG_B.id,
    accountId: 'account-1',
    role: 'ADMIN',
    status: 'ACTIVE',
    isActive: () => true,
    ...overrides,
  };
}

function buildHarness({
  selectedOrganizationId,
  owned = null,
  membershipInSelected = null,
  defaultMembership = null,
  organizationsById = {},
}: {
  selectedOrganizationId?: string;
  owned?: Record<string, unknown> | null;
  membershipInSelected?: Record<string, unknown> | null;
  defaultMembership?: Record<string, unknown> | null;
  organizationsById?: Record<string, unknown>;
} = {}) {
  const organizationsRepository = {
    findByOwnerId: jest.fn().mockResolvedValue(owned),
    findById: jest.fn((id: string) =>
      Promise.resolve(organizationsById[id] ?? null),
    ),
  };

  const organizationUsersRepository = {
    findByOrganizationIdAndAccountId: jest
      .fn()
      .mockResolvedValue(membershipInSelected),
    findByAccountId: jest.fn().mockResolvedValue(defaultMembership),
  };

  const requestContext = {
    getOrganizationId: jest.fn().mockReturnValue(selectedOrganizationId),
  };

  const resolver = new CurrentOrganizationResolver(
    organizationsRepository as never,
    organizationUsersRepository as never,
    requestContext as never,
  );

  return { resolver, organizationsRepository, organizationUsersRepository };
}

describe('CurrentOrganizationResolver', () => {
  describe('with X-Organization-Id selected', () => {
    it('resolves the selected organization, not the owned one', async () => {
      // The regression this exists for: an account that owns A and administers B
      // used to read A while its writes landed on B.
      const { resolver } = buildHarness({
        selectedOrganizationId: ORG_B.id,
        owned: ORG_A,
        membershipInSelected: membership(),
        organizationsById: { [ORG_B.id]: ORG_B },
      });

      const current = await resolver.resolve('account-1');

      expect(current.organization).toBe(ORG_B);
      expect(current.role).toBe('ADMIN');
    });

    it('denies an organization the account has no active membership in', async () => {
      const { resolver } = buildHarness({
        selectedOrganizationId: ORG_B.id,
        membershipInSelected: null,
        organizationsById: { [ORG_B.id]: ORG_B },
      });

      await expect(resolver.resolve('account-1')).rejects.toMatchObject({
        response: { code: 'ORGANIZATION_ACCESS_DENIED' },
      });
    });

    it('denies a membership that is not active', async () => {
      const { resolver } = buildHarness({
        selectedOrganizationId: ORG_B.id,
        membershipInSelected: membership({
          status: 'BLOCKED',
          isActive: () => false,
        }),
        organizationsById: { [ORG_B.id]: ORG_B },
      });

      await expect(resolver.resolve('account-1')).rejects.toMatchObject({
        response: { code: 'ORGANIZATION_ACCESS_DENIED' },
      });
    });

    it('answers the same error for an organization that does not exist', async () => {
      // Same code as "not yours", so the header cannot probe which orgs exist.
      const { resolver } = buildHarness({
        selectedOrganizationId: 'org-ghost',
        organizationsById: {},
      });

      await expect(resolver.resolve('account-1')).rejects.toMatchObject({
        response: { code: 'ORGANIZATION_ACCESS_DENIED' },
      });
    });

    it('lets the owner through even without a membership row', async () => {
      const { resolver } = buildHarness({
        selectedOrganizationId: ORG_A.id,
        membershipInSelected: null,
        organizationsById: { [ORG_A.id]: ORG_A },
      });

      const current = await resolver.resolve('account-1');

      expect(current.organization).toBe(ORG_A);
      expect(current.role).toBe('OWNER');
    });
  });

  describe('without a header (unchanged behaviour)', () => {
    it('falls back to the owned organization', async () => {
      const { resolver } = buildHarness({ owned: ORG_A });

      await expect(resolver.resolve('account-1')).resolves.toMatchObject({
        organization: ORG_A,
        role: 'OWNER',
      });
    });

    it('falls back to the first membership when nothing is owned', async () => {
      const { resolver } = buildHarness({
        owned: null,
        defaultMembership: membership(),
        organizationsById: { [ORG_B.id]: ORG_B },
      });

      await expect(resolver.resolve('account-1')).resolves.toMatchObject({
        organization: ORG_B,
        role: 'ADMIN',
      });
    });

    it('reports ORGANIZATION_NOT_FOUND when the account has none', async () => {
      // A personal-workspace account: an empty state for the UI, not an error.
      const { resolver } = buildHarness({
        owned: null,
        defaultMembership: null,
      });

      await expect(resolver.resolve('account-1')).rejects.toMatchObject({
        response: { code: 'ORGANIZATION_NOT_FOUND' },
      });
    });
  });

  describe('canManageMembers', () => {
    it.each([
      ['OWNER', true],
      ['ADMIN', true],
      ['FINANCE', false],
      ['ANALYST', false],
      ['MEMBER', false],
      ['VIEWER', false],
    ])('%s -> %s', (role, expected) => {
      const { resolver } = buildHarness();

      expect(
        resolver.canManageMembers({
          organization: ORG_B as never,
          accountId: 'account-1',
          role: role as never,
          membershipId: 'membership-1',
        }),
      ).toBe(expected);
    });

    it('always allows the owner, whatever the membership role says', async () => {
      const { resolver } = buildHarness();

      expect(
        resolver.canManageMembers({
          organization: ORG_A as never,
          accountId: 'account-1',
          role: 'VIEWER',
          membershipId: null,
        }),
      ).toBe(true);
    });
  });
});
