import { ExpireOrganizationTrialsUseCase } from './expire-organization-trials.usecase';

function buildHarness(expiredTrials: { id: string; organizationId: string }[]) {
  const organizationEntitlementRepository = {
    findEffectiveForAccount: jest.fn(),
    listExpiredTrials: jest.fn().mockResolvedValue(expiredTrials),
    markExpired: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new ExpireOrganizationTrialsUseCase(
    organizationEntitlementRepository as any,
    auditLog as any,
  );

  return { useCase, organizationEntitlementRepository, auditLog };
}

describe('ExpireOrganizationTrialsUseCase', () => {
  it('marks each elapsed trial as expired and records an audit event', async () => {
    const h = buildHarness([
      { id: 'orgsub-1', organizationId: 'org-1' },
      { id: 'orgsub-2', organizationId: 'org-2' },
    ]);

    await expect(h.useCase.execute()).resolves.toEqual({
      scanned: 2,
      expired: 2,
    });

    expect(
      h.organizationEntitlementRepository.markExpired,
    ).toHaveBeenCalledTimes(2);
    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'subscription.trial_expired',
        entityId: 'orgsub-1',
        organizationId: 'org-1',
      }),
    );
  });

  it('keeps processing when one trial fails to expire', async () => {
    const h = buildHarness([
      { id: 'orgsub-1', organizationId: 'org-1' },
      { id: 'orgsub-2', organizationId: 'org-2' },
    ]);
    h.organizationEntitlementRepository.markExpired.mockRejectedValueOnce(
      new Error('db timeout'),
    );

    const result = await h.useCase.execute();

    expect(result).toEqual({ scanned: 2, expired: 1 });
    expect(
      h.organizationEntitlementRepository.markExpired,
    ).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there are no elapsed trials', async () => {
    const h = buildHarness([]);

    await expect(h.useCase.execute()).resolves.toEqual({
      scanned: 0,
      expired: 0,
    });
    expect(
      h.organizationEntitlementRepository.markExpired,
    ).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });
});
