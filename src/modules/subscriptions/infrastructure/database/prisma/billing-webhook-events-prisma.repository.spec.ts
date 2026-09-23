import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BillingWebhookEventRecord } from 'src/modules/subscriptions/domain/ports';
import { BillingWebhookEventsPrismaRepository } from './billing-webhook-events-prisma.repository';

function uniqueConstraintViolation(): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}

function buildRepository(billingWebhookEvent: {
  create: jest.Mock;
  findUnique: jest.Mock;
}) {
  const prisma = { billingWebhookEvent } as unknown as PrismaService;
  return new BillingWebhookEventsPrismaRepository(prisma);
}

const record: BillingWebhookEventRecord = {
  provider: 'STRIPE',
  eventKey: 'evt_1',
  topic: 'invoice.paid',
  resourceId: 'in_1',
  payload: {},
};

describe('BillingWebhookEventsPrismaRepository.claim', () => {
  it('claims a brand-new event', async () => {
    const create = jest.fn().mockResolvedValue({});
    const repository = buildRepository({ create, findUnique: jest.fn() });

    await expect(repository.claim(record)).resolves.toBe('CLAIMED');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('skips an event that already completed', async () => {
    const repository = buildRepository({
      create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
      findUnique: jest.fn().mockResolvedValue({ processedAt: new Date() }),
    });

    await expect(repository.claim(record)).resolves.toBe('ALREADY_PROCESSED');
  });

  // This is the regression the whole claim() contract exists to prevent: an
  // event recorded by a previous attempt that died before finishing must be
  // reprocessed, not silently dropped.
  it('re-claims an event that was recorded but never processed', async () => {
    const repository = buildRepository({
      create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
      findUnique: jest.fn().mockResolvedValue({ processedAt: null }),
    });

    await expect(repository.claim(record)).resolves.toBe('CLAIMED');
  });

  it('claims when the row vanished between insert and lookup', async () => {
    const repository = buildRepository({
      create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(repository.claim(record)).resolves.toBe('CLAIMED');
  });

  it('propagates errors that are not unique-constraint violations', async () => {
    const repository = buildRepository({
      create: jest.fn().mockRejectedValue(new Error('connection lost')),
      findUnique: jest.fn(),
    });

    await expect(repository.claim(record)).rejects.toThrow('connection lost');
  });
});
