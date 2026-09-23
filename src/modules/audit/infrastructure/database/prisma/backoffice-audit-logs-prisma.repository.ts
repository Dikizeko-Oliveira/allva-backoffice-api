import { Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import {
  BackofficeAuditAction,
  BackofficeAuditLog,
} from 'src/modules/audit/domain/entities';
import {
  BackofficeAuditLogsRepositoryInterface,
  ListBackofficeAuditLogsFilter,
} from 'src/modules/audit/domain/ports';
import {
  offsetOf,
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import { toNullablePrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class BackofficeAuditLogsPrismaRepository implements BackofficeAuditLogsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(log: BackofficeAuditLog): Promise<void> {
    await this.prisma.backofficeAuditLog.create({
      data: {
        id: log.id,
        actorId: log.actorId,
        action: log.action,
        subjectType: log.subjectType,
        subjectId: log.subjectId,
        before: toNullablePrismaJson(log.before),
        after: toNullablePrismaJson(log.after),
        reason: log.reason,
        ip: log.ip,
        userAgent: log.userAgent,
        createdAt: log.createdAt,
      },
    });
  }

  async list(
    filter: ListBackofficeAuditLogsFilter,
    page: PageParams,
  ): Promise<PageResult<BackofficeAuditLog>> {
    const where: Prisma.BackofficeAuditLogWhereInput = {
      actorId: filter.actorId,
      action: filter.action,
      subjectId: filter.subjectId,
      createdAt:
        filter.from || filter.to
          ? { gte: filter.from, lte: filter.to }
          : undefined,
    };

    const [records, total] = await Promise.all([
      this.prisma.backofficeAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offsetOf(page),
        take: page.pageSize,
      }),
      this.prisma.backofficeAuditLog.count({ where }),
    ]);

    return {
      items: records.map((record) =>
        BackofficeAuditLog.restore({
          id: record.id,
          actorId: record.actorId,
          action: record.action as BackofficeAuditAction,
          subjectType: record.subjectType,
          subjectId: record.subjectId,
          before: record.before,
          after: record.after,
          reason: record.reason,
          ip: record.ip,
          userAgent: record.userAgent,
          createdAt: record.createdAt,
        }),
      ),
      total,
      ...page,
    };
  }
}
