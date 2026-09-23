import { AuditLogService } from './audit-log.service';

function buildHarness({ saveFails = false } = {}) {
  const save = jest
    .fn()
    .mockImplementation(() =>
      saveFails
        ? Promise.reject(new Error('audit db down'))
        : Promise.resolve(),
    );

  const service = new AuditLogService({ save } as never);
  const error = jest
    .spyOn((service as any).logger, 'error')
    .mockImplementation(() => undefined);

  return { service, save, error };
}

describe('AuditLogService', () => {
  it('persists the event with its actor, entity and metadata', async () => {
    const h = buildHarness();

    await h.service.record({
      event: 'integration.connected',
      entityType: 'integration',
      entityId: 'int-1',
      actorId: 'acc-1',
      organizationId: 'org-1',
      metadata: { provider: 'META' },
    });

    const [saved] = h.save.mock.calls[0];
    expect(saved.event).toBe('integration.connected');
    expect(saved.entityId).toBe('int-1');
    expect(saved.actorId).toBe('acc-1');
    expect(saved.organizationId).toBe('org-1');
    expect(saved.metadata).toEqual({ provider: 'META' });
  });

  it('stamps an id and a creation time', async () => {
    const h = buildHarness();

    await h.service.record({ event: 'account.created' });

    const [saved] = h.save.mock.calls[0];
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.createdAt).toBeInstanceOf(Date);
  });

  it('normalises absent optional fields to null', async () => {
    const h = buildHarness();

    await h.service.record({ event: 'account.deleted' });

    const [saved] = h.save.mock.calls[0];
    expect(saved.entityType).toBeNull();
    expect(saved.organizationId).toBeNull();
    expect(saved.metadata).toBeNull();
  });

  /**
   * The guarantee every caller depends on. Audit writes sit *after* the business
   * operation, so throwing here would fail an operation that already succeeded —
   * e.g. an account deleted from the database but the request reported as failed.
   */
  it('never throws when persistence fails', async () => {
    const h = buildHarness({ saveFails: true });

    await expect(
      h.service.record({ event: 'account.deleted', entityId: 'acc-1' }),
    ).resolves.toBeUndefined();
  });

  it('logs the failure with enough context to reconstruct the lost event', async () => {
    const h = buildHarness({ saveFails: true });

    await h.service.record({
      event: 'integration.disconnected',
      entityId: 'int-1',
      organizationId: 'org-1',
    });

    const [message] = h.error.mock.calls[0];
    expect(message).toContain('audit.record_failed');
    expect(message).toContain('integration.disconnected');
    expect(message).toContain('int-1');
  });
});
