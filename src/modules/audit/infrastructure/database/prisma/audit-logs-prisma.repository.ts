import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { AuditLog, AuditEvent } from 'src/modules/audit/domain/entities';
import { AuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AuditLogsPrismaRepository implements AuditLogsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(auditLog: AuditLog): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        id: auditLog.id,
        event: auditLog.event,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        actorId: auditLog.actorId,
        organizationId: auditLog.organizationId,
        metadata: (auditLog.metadata ?? undefined) as Prisma.InputJsonValue,
        createdAt: auditLog.createdAt,
      },
    });
  }

  async listByOrganizationId(
    organizationId: string,
    limit = 100,
  ): Promise<AuditLog[]> {
    const records = await this.prisma.auditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return records.map((record) =>
      AuditLog.restore({
        id: record.id,
        event: record.event as AuditEvent,
        entityType: record.entityType,
        entityId: record.entityId,
        actorId: record.actorId,
        organizationId: record.organizationId,
        metadata: (record.metadata ?? null) as Record<string, unknown> | null,
        createdAt: record.createdAt,
      }),
    );
  }
}
