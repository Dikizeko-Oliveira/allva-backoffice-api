import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { SecurityAuditLog } from 'src/modules/security/domain/entities';
import {
  CountByEventParams,
  DistinctIpCountParams,
  SecurityAuditLogsRepositoryInterface,
} from 'src/modules/security/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class SecurityAuditLogsPrismaRepository implements SecurityAuditLogsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(log: SecurityAuditLog): Promise<void> {
    await this.prisma.securityAuditLog.create({
      data: {
        id: log.id,
        event: log.event,
        severity: log.severity,
        accountId: log.accountId,
        organizationId: log.organizationId,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        metadata: (log.metadata ?? undefined) as Prisma.InputJsonValue,
        createdAt: log.createdAt,
      },
    });
  }

  async countByEventSince(params: CountByEventParams): Promise<number> {
    return this.prisma.securityAuditLog.count({
      where: {
        event: params.event,
        createdAt: { gte: params.since },
        ...(params.ipAddress ? { ipAddress: params.ipAddress } : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
      },
    });
  }

  async distinctIpCountByAccountSince(
    params: DistinctIpCountParams,
  ): Promise<number> {
    const rows = await this.prisma.securityAuditLog.findMany({
      where: {
        accountId: params.accountId,
        createdAt: { gte: params.since },
        ipAddress: { not: null },
      },
      distinct: ['ipAddress'],
      select: { ipAddress: true },
    });

    return rows.length;
  }
}
