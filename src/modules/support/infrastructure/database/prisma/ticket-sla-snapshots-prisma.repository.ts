import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  TicketSlaSnapshot as TicketSlaSnapshotRecord,
} from 'generated/prisma/client';
import { TicketSlaSnapshot } from 'src/modules/support/domain/entities';
import {
  SlaCompliance,
  SlaComplianceFilter,
  TicketSlaSnapshotsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class TicketSlaSnapshotsPrismaRepository implements TicketSlaSnapshotsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findByTicketIds(
    ticketIds: readonly string[],
  ): Promise<Map<string, TicketSlaSnapshot>> {
    const records = await this.prisma.ticketSlaSnapshot.findMany({
      where: { ticketId: { in: [...ticketIds] } },
    });

    return new Map(
      records.map((record) => [record.ticketId, toEntity(record)] as const),
    );
  }

  /**
   * `upsert`, e não `create` + `update`: duas telas abrindo a fila ao mesmo
   * tempo veem o mesmo chamado novo, e a segunda criação não pode falhar por
   * unicidade.
   */
  async saveMany(snapshots: readonly TicketSlaSnapshot[]): Promise<void> {
    await this.prisma.$transaction(
      snapshots.map((snapshot) => {
        const data = toData(snapshot);
        return this.prisma.ticketSlaSnapshot.upsert({
          where: { ticketId: snapshot.ticketId },
          create: data,
          update: data,
        });
      }),
    );
  }

  async compliance(filter: SlaComplianceFilter): Promise<SlaCompliance> {
    const where: Prisma.TicketSlaSnapshotWhereInput = {
      openedAt:
        filter.from || filter.to
          ? { gte: filter.from, lte: filter.to }
          : undefined,
      assigneeId: filter.assigneeId,
    };

    const [total, breached] = await Promise.all([
      this.prisma.ticketSlaSnapshot.count({ where }),
      this.prisma.ticketSlaSnapshot.count({
        where: {
          ...where,
          // Comparação entre colunas: resolvido depois do próprio prazo. Linha
          // sem prazo ou sem resolução compara com NULL e fica de fora.
          resolvedAt: {
            gt: this.prisma.ticketSlaSnapshot.fields.dueResolutionAt,
          },
        },
      }),
    ]);

    return { total, breached };
  }
}

function toData(snapshot: TicketSlaSnapshot) {
  return {
    ticketId: snapshot.ticketId,
    priority: snapshot.priority,
    category: snapshot.category,
    status: snapshot.status,
    assigneeId: snapshot.assigneeId,
    openedAt: snapshot.openedAt,
    lastMessageAt: snapshot.lastMessageAt,
    lastMessageKind: snapshot.lastMessageKind,
    dueFirstResponseAt: snapshot.dueFirstResponseAt,
    dueResolutionAt: snapshot.dueResolutionAt,
    firstOperatorReplyAt: snapshot.firstOperatorReplyAt,
    resolvedAt: snapshot.resolvedAt,
    escalatedAt: snapshot.escalatedAt,
    escalatedTo: snapshot.escalatedTo,
    escalatedAcknowledgedAt: snapshot.escalatedAcknowledgedAt,
    updatedAt: snapshot.updatedAt,
  };
}

function toEntity(record: TicketSlaSnapshotRecord): TicketSlaSnapshot {
  return TicketSlaSnapshot.restore({
    ticketId: record.ticketId,
    priority: record.priority,
    category: record.category,
    status: record.status,
    assigneeId: record.assigneeId,
    openedAt: record.openedAt,
    lastMessageAt: record.lastMessageAt,
    lastMessageKind: record.lastMessageKind,
    dueFirstResponseAt: record.dueFirstResponseAt,
    dueResolutionAt: record.dueResolutionAt,
    firstOperatorReplyAt: record.firstOperatorReplyAt,
    resolvedAt: record.resolvedAt,
    escalatedAt: record.escalatedAt,
    escalatedTo: record.escalatedTo,
    escalatedAcknowledgedAt: record.escalatedAcknowledgedAt,
    updatedAt: record.updatedAt,
  });
}
