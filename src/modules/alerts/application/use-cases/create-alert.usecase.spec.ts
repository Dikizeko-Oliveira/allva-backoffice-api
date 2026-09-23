import {
  AlertDTO,
  CreateAlertInput,
} from 'src/modules/alerts/domain/ports/alerts.repository';
import { CreateAlertUseCase } from './alert-use-cases';

const INPUT: CreateAlertInput = {
  organizationId: 'org-1',
  type: 'WASTE_DETECTED',
  severity: 'CRITICAL',
  title: 'Desperdicio critico detectado',
  message: 'Campanha X gastou R$ 1.200 sem conversao.',
  subject: { kind: 'WASTE_ITEM', wasteItemId: 'waste-42' },
};

function buildAlert(overrides: Partial<AlertDTO> = {}): AlertDTO {
  return {
    ...INPUT,
    id: 'alert-1',
    isRead: false,
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    notifiedAt: null,
    occurrences: 1,
    firstOccurredAt: new Date('2026-07-25T10:00:00.000Z'),
    lastOccurredAt: new Date('2026-07-25T10:00:00.000Z'),
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness({ created = true }: { created?: boolean } = {}) {
  const createOrRecur = jest.fn().mockResolvedValue({
    alert: buildAlert({ occurrences: created ? 1 : 4 }),
    created,
  });
  const repo = { createOrRecur } as never;

  const notify = jest.fn().mockResolvedValue({ delivered: true });
  const notifier = { notify } as never;

  const useCase = new CreateAlertUseCase(repo, notifier);
  jest
    .spyOn((useCase as any).logger, 'log')
    .mockImplementation(() => undefined);

  return { useCase, createOrRecur, notify };
}

describe('CreateAlertUseCase', () => {
  it('creates the alert and notifies when it is new', async () => {
    const h = buildHarness({ created: true });

    await h.useCase.execute(INPUT);

    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('passes a fingerprint so the repository can deduplicate', async () => {
    const h = buildHarness();

    await h.useCase.execute(INPUT);

    expect(h.createOrRecur).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: expect.stringContaining('org-1'),
      }),
    );
  });

  /**
   * The whole reason deduplication exists. Waste detection runs daily and re-reports
   * the same persistent condition; without this, enabling delivery would have meant a
   * fresh email every morning for a problem the user already knows about.
   */
  it('does not notify again when the alert is a recurrence', async () => {
    const h = buildHarness({ created: false });

    await h.useCase.execute(INPUT);

    expect(h.createOrRecur).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('returns the existing alert on a recurrence, carrying the occurrence count', async () => {
    const h = buildHarness({ created: false });

    const result = await h.useCase.execute(INPUT);

    expect(result.occurrences).toBe(4);
  });

  it('builds the same fingerprint across runs whose wording changed', async () => {
    const h = buildHarness();

    await h.useCase.execute(INPUT);
    await h.useCase.execute({ ...INPUT, title: 'Texto reescrito pelo motor' });

    const [first] = h.createOrRecur.mock.calls[0];
    const [second] = h.createOrRecur.mock.calls[1];
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('separates alerts of different organizations', async () => {
    const h = buildHarness();

    await h.useCase.execute(INPUT);
    await h.useCase.execute({ ...INPUT, organizationId: 'org-2' });

    const [first] = h.createOrRecur.mock.calls[0];
    const [second] = h.createOrRecur.mock.calls[1];
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('still returns the alert when delivery reports a failure', async () => {
    const h = buildHarness();
    h.notify.mockResolvedValue({ delivered: false, reason: 'send_failed' });

    // The alert exists in-app; a mail problem must not turn into a lost alert.
    await expect(h.useCase.execute(INPUT)).resolves.toMatchObject({
      id: 'alert-1',
    });
  });
});
