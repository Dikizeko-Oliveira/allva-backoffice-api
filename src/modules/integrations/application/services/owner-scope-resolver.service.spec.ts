import { OwnerScopeResolverService } from './owner-scope-resolver.service';

function activeMembership(organizationId: string) {
  return { isActive: () => true, organizationId };
}

function buildResolver() {
  const orgUsers = {
    findByAccountId: jest.fn().mockResolvedValue(null),
    findByOrganizationIdAndAccountId: jest.fn().mockResolvedValue(null),
  };
  const integrations = {};
  const prisma = {
    organization: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const requestContext = {
    getOrganizationId: jest.fn().mockReturnValue(undefined),
  };

  const resolver = new OwnerScopeResolverService(
    orgUsers as any,
    integrations as any,
    prisma as any,
    requestContext as any,
  );

  return { resolver, orgUsers, prisma, requestContext };
}

describe('OwnerScopeResolverService.resolveForAccount (A-6)', () => {
  it('honors the explicitly selected organization for an ACTIVE member', async () => {
    const h = buildResolver();
    h.orgUsers.findByOrganizationIdAndAccountId.mockResolvedValue(
      activeMembership('org-selected'),
    );

    const scope = await h.resolver.resolveForAccount('acc-1', 'org-selected');

    expect(scope).toEqual({
      accountId: 'acc-1',
      organizationId: 'org-selected',
    });
    expect(h.orgUsers.findByOrganizationIdAndAccountId).toHaveBeenCalledWith(
      'org-selected',
      'acc-1',
    );
  });

  it('honors the org from the per-request context over an arbitrary default', async () => {
    const h = buildResolver();
    // The header selected org-header...
    h.requestContext.getOrganizationId.mockReturnValue('org-header');
    h.orgUsers.findByOrganizationIdAndAccountId.mockResolvedValue(
      activeMembership('org-header'),
    );
    // ...while the legacy default pick would have returned a different org.
    h.orgUsers.findByAccountId.mockResolvedValue(
      activeMembership('org-arbitrary'),
    );

    const scope = await h.resolver.resolveForAccount('acc-1');

    expect(scope.organizationId).toBe('org-header');
    // Default path must not be consulted when the selection resolves.
    expect(h.orgUsers.findByAccountId).not.toHaveBeenCalled();
  });

  it('falls back to the default membership when no org is selected', async () => {
    const h = buildResolver();
    h.orgUsers.findByAccountId.mockResolvedValue(
      activeMembership('org-default'),
    );

    const scope = await h.resolver.resolveForAccount('acc-1');

    expect(scope.organizationId).toBe('org-default');
  });

  it('falls back to an owned organization when there is no membership', async () => {
    const h = buildResolver();
    h.prisma.organization.findFirst.mockResolvedValue({ id: 'org-owned' });

    const scope = await h.resolver.resolveForAccount('acc-1');

    expect(scope.organizationId).toBe('org-owned');
  });

  it('resolves the account scope when the user has no organization', async () => {
    const h = buildResolver();

    const scope = await h.resolver.resolveForAccount('acc-1');

    expect(scope).toEqual({ accountId: 'acc-1', organizationId: null });
  });

  it('ignores an unresolvable selected org and falls back to the default', async () => {
    const h = buildResolver();
    // Not a member of the selected org, and does not own it.
    h.requestContext.getOrganizationId.mockReturnValue('org-forged');
    h.orgUsers.findByOrganizationIdAndAccountId.mockResolvedValue(null);
    h.prisma.organization.findFirst.mockResolvedValue({ id: 'org-owned' });

    const scope = await h.resolver.resolveForAccount('acc-1');

    expect(scope.organizationId).toBe('org-owned');
  });
});
