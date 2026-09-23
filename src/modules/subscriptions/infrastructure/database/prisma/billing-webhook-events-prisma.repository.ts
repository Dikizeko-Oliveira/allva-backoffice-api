import { Injectable } from '@nestjs/common';
import {
  BillingWebhookEventClaim,
  BillingWebhookEventRecord,
  BillingWebhookEventsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

@Injectable()
export class BillingWebhookEventsPrismaRepository implements BillingWebhookEventsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async claim(
    event: BillingWebhookEventRecord,
  ): Promise<BillingWebhookEventClaim> {
    try {
      await this.prisma.billingWebhookEvent.create({
        data: {
          provider: event.provider,
          eventKey: event.eventKey,
          topic: event.topic,
          action: event.action,
          externalEventId: event.externalEventId,
          resourceId: event.resourceId,
          payload: toPrismaJson(event.payload),
          processedAt: null,
        },
      });

      return 'CLAIMED';
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }

      // The event was already recorded. Only a *completed* event is a true
      // duplicate — one still missing `processedAt` means a previous attempt
      // died mid-flight, so this retry gets to finish the job.
      const existing = await this.prisma.billingWebhookEvent.findUnique({
        where: { eventKey: event.eventKey },
        select: { processedAt: true },
      });

      return existing?.processedAt ? 'ALREADY_PROCESSED' : 'CLAIMED';
    }
  }

  async markProcessed(eventKey: string): Promise<void> {
    await this.prisma.billingWebhookEvent.update({
      where: { eventKey },
      data: { processedAt: new Date() },
    });
  }
}
