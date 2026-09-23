import { Injectable } from '@nestjs/common';
import type { TicketAssignmentEvent } from 'src/modules/support/domain/entities';
import {
  AssignmentVolumeFilter,
  TicketAssignmentEventsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class TicketAssignmentEventsPrismaRepository implements TicketAssignmentEventsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(event: TicketAssignmentEvent): Promise<void> {
    await this.prisma.ticketAssignmentEvent.create({
      data: {
        id: event.id,
        ticketId: event.ticketId,
        fromOperatorId: event.fromOperatorId,
        toOperatorId: event.toOperatorId,
        actorId: event.actorId,
        reason: event.reason,
        createdAt: event.createdAt,
      },
    });
  }

  async count(filter: AssignmentVolumeFilter): Promise<number> {
    return this.prisma.ticketAssignmentEvent.count({
      where: {
        toOperatorId: filter.toOperatorId,
        createdAt:
          filter.from || filter.to
            ? { gte: filter.from, lte: filter.to }
            : undefined,
      },
    });
  }
}
