import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { AlertsPrismaRepository } from './alerts-prisma.repository';

const INPUT = {
  organizationId: 'org-1',
  type: 'WASTE_DETECTED' as const,
  severity: 'CRITICAL' as const,
  title: 'Desperdicio critico',
  message: 'Diagnostico',
  subject: { kind: 'WASTE_ITEM' as const, wasteItemId: 'waste-42' },
  fingerprint: 'org-1|WASTE_DETECTED|WASTE_ITEM|waste-42|-',
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    organizationId: 'org-1',
    type: 'WASTE_DETECTED',
    severity: 'CRITICAL',
    title: 'Desperdicio critico',
    message: 'Diagnostico',
    adId: null,
    adAccountId: null,
    wasteItemId: 'waste-42',
    recommendationId: null,
    actionExecutionId: null,
    integrationId: null,
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

function buildHarness({ existing = null }: { existing?: unknown } = {}) {
  const findFirst = jest.fn().mockResolvedValue(existing);
  const create = jest.fn().mockResolvedValue(record());
  const update = jest
    .fn()
    .mockImplementation(({ data }) =>
      Promise.resolve(record({ ...(data as object) })),
    );
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const updateMany = jest.fn().mockResolvedValue({ count: 3 });

  const prisma = {
    alert: { findFirst, create, update, findMany, count, updateMany },
  } as unknown as PrismaService;

  return {
    repository: new AlertsPrismaRepository(prisma),
    findFirst,
    create,
    update,
    findMany,
    count,
  };
}

describe('AlertsPrismaRepository', () => {
  describe('createOrRecur', () => {
    it('creates a new alert when no open one shares the fingerprint', async () => {
      const h = buildHarness({ existing: null });

      const result = await h.repository.createOrRecur(INPUT);

      expect(result.created).toBe(true);
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fingerprint: INPUT.fingerprint }),
        }),
      );
    });

    it('only considers OPEN alerts as duplicates', async () => {
      const h = buildHarness();

      await h.repository.createOrRecur(INPUT);

      // A resolved alert must not absorb a recurrence: the problem came back, and
      // that is new information deserving its own alert and email.
      expect(h.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            fingerprint: INPUT.fingerprint,
            dismissedAt: null,
            resolvedAt: null,
          }),
        }),
      );
    });

    it('records a recurrence instead of creating a second alert', async () => {
      const h = buildHarness({ existing: record() });

      const result = await h.repository.createOrRecur(INPUT);

      expect(result.created).toBe(false);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ occurrences: { increment: 1 } }),
        }),
      );
    });

    it('lets a recurrence escalate the severity and refresh the wording', async () => {
      const h = buildHarness({ existing: record({ severity: 'WARNING' }) });

      await h.repository.createOrRecur({ ...INPUT, severity: 'CRITICAL' });

      expect(h.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            severity: 'CRITICAL',
            message: INPUT.message,
          }),
        }),
      );
    });
  });

  describe('list', () => {
    it('defaults to open alerts only', async () => {
      const h = buildHarness();

      await h.repository.list({ organizationId: 'org-1' });

      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            dismissedAt: null,
            resolvedAt: null,
          }),
        }),
      );
    });

    // M-2 "priorizacao": a CRITICAL alert must not sit below a newer INFO one.
    it('orders by severity before recency', async () => {
      const h = buildHarness();

      await h.repository.list({ organizationId: 'org-1' });

      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        }),
      );
    });

    it.each([
      ['DISMISSED', { dismissedAt: { not: null } }],
      ['RESOLVED', { resolvedAt: { not: null } }],
    ])('filters by the %s state', async (state, expected) => {
      const h = buildHarness();

      await h.repository.list({
        organizationId: 'org-1',
        state: state as never,
      });

      expect(h.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(expected) }),
      );
    });

    it('applies no lifecycle filter for ALL', async () => {
      const h = buildHarness();

      await h.repository.list({ organizationId: 'org-1', state: 'ALL' });

      const [{ where }] = h.findMany.mock.calls[0];
      expect(where).not.toHaveProperty('dismissedAt');
      expect(where).not.toHaveProperty('resolvedAt');
    });
  });

  describe('findById', () => {
    it('returns the alert scoped to the organization', async () => {
      const h = buildHarness({ existing: record() });

      const alert = await h.repository.findById('alert-1', 'org-1');

      expect(h.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'alert-1', organizationId: 'org-1' },
        }),
      );
      expect(alert?.id).toBe('alert-1');
    });

    it('returns null for an alert belonging to another organization', async () => {
      const h = buildHarness({ existing: null });

      await expect(
        h.repository.findById('alert-1', 'org-2'),
      ).resolves.toBeNull();
    });
  });

  describe('dismiss / resolve', () => {
    it('returns null for an alert belonging to another organization', async () => {
      const h = buildHarness({ existing: null });

      await expect(
        h.repository.dismiss('alert-1', 'org-2'),
      ).resolves.toBeNull();
      expect(h.update).not.toHaveBeenCalled();
    });

    it.each([
      ['dismiss', 'dismissedAt'],
      ['resolve', 'resolvedAt'],
    ])('%s stamps %s and marks the alert read', async (method, field) => {
      const h = buildHarness({ existing: record() });

      await (h.repository as any)[method]('alert-1', 'org-1');

      const [{ data }] = h.update.mock.calls[0];
      expect(data[field]).toBeInstanceOf(Date);
      // Fechar um alerta o tira da fila de qualquer jeito, então ele também
      // fica lido. No v2.0 "lido" é a data, não um booleano paralelo que podia
      // divergir dela.
      expect(data.readAt).toBeInstanceOf(Date);
    });

    it.each([
      ['dismiss', 'dismissedAt'],
      ['resolve', 'resolvedAt'],
    ])('%s is idempotent — the first timestamp wins', async (method, field) => {
      const alreadyClosed = new Date('2026-07-20T10:00:00.000Z');
      const h = buildHarness({ existing: record({ [field]: alreadyClosed }) });

      const result = await (h.repository as any)[method]('alert-1', 'org-1');

      expect(h.update).not.toHaveBeenCalled();
      expect(result[field]).toEqual(alreadyClosed);
    });

    it('does not re-stamp readAt on an alert already read', async () => {
      const readAt = new Date('2026-07-21T10:00:00.000Z');
      const h = buildHarness({ existing: record({ isRead: true, readAt }) });

      await h.repository.dismiss('alert-1', 'acc-1');

      const [{ data }] = h.update.mock.calls[0];
      expect(data).not.toHaveProperty('readAt');
    });
  });

  describe('markNotified', () => {
    it('stamps the delivery time on the alert', async () => {
      const h = buildHarness();
      const at = new Date('2026-07-25T11:00:00.000Z');

      await h.repository.markNotified('alert-1', at);

      expect(h.update).toHaveBeenCalledWith({
        where: { id: 'alert-1' },
        data: { notifiedAt: at },
      });
    });
  });
});

/**
 * As seis FKs tipadas são a correção do alerta órfão do v1: um `referenceType`
 * preenchido sem `referenceId` produzia alerta apontando para lugar nenhum, e
 * nada no banco impedia. O round-trip abaixo prova que cada sujeito sobrevive à
 * ida e à volta — e o `CHECK alerts_one_subject` (verificado em
 * `test/architecture/schema-gates-db.spec.ts`) prova que o banco recusa a linha
 * sem sujeito.
 */
describe('sujeitos tipados', () => {
  const SUBJECTS = [
    [{ kind: 'AD' as const, adId: 'ad-1' }, 'adId'],
    [{ kind: 'AD_ACCOUNT' as const, adAccountId: 'acct-1' }, 'adAccountId'],
    [{ kind: 'WASTE_ITEM' as const, wasteItemId: 'waste-1' }, 'wasteItemId'],
    [
      { kind: 'RECOMMENDATION' as const, recommendationId: 'reco-1' },
      'recommendationId',
    ],
    [
      { kind: 'ACTION_EXECUTION' as const, actionExecutionId: 'exec-1' },
      'actionExecutionId',
    ],
    [{ kind: 'INTEGRATION' as const, integrationId: 'int-1' }, 'integrationId'],
  ] as const;

  it.each(SUBJECTS.map(([subject, column]) => [subject.kind, subject, column]))(
    'grava %s em %s e nas demais colunas grava null',
    async (_kind, subject, column) => {
      const h = buildHarness({ existing: null });

      await h.repository.createOrRecur({ ...INPUT, subject });

      const [{ data }] = h.create.mock.calls[0];
      expect(data[column]).toBe(Object.values(subject)[1]);

      const written = [
        'adId',
        'adAccountId',
        'wasteItemId',
        'recommendationId',
        'actionExecutionId',
        'integrationId',
      ].filter((field) => data[field] !== null);
      // Exatamente um: é o que o CHECK do banco também exige.
      expect(written).toEqual([column]);
    },
  );

  it('reconstrói o sujeito na leitura', async () => {
    const h = buildHarness({ existing: null });
    h.create.mockResolvedValue(
      record({
        wasteItemId: null,
        adId: 'ad-9',
      }),
    );

    const { alert } = await h.repository.createOrRecur({
      ...INPUT,
      subject: { kind: 'AD', adId: 'ad-9' },
    });

    expect(alert.subject).toEqual({ kind: 'AD', adId: 'ad-9' });
  });

  it('recusa devolver alerta sem sujeito em vez de devolver órfão', async () => {
    const h = buildHarness({ existing: null });
    h.create.mockResolvedValue(record({ wasteItemId: null }));

    // Só acontece se alguém remover o CHECK do banco. Falhar alto é melhor que
    // devolver o alerta órfão que o modelo existe para impedir.
    await expect(h.repository.createOrRecur(INPUT)).rejects.toThrow(
      /não declara sujeito/,
    );
  });
});
