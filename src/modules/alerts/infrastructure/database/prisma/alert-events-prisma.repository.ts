import { Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { AlertEvent } from 'src/modules/alerts/domain/entities';
import {
  AlertEventsRepositoryInterface,
  ListAlertEventsFilter,
} from 'src/modules/alerts/domain/ports';
import {
  offsetOf,
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const WITH_RULE_PERMISSION = {
  rule: { select: { requiredPermission: true } },
} as const;

type AlertEventWithRule = Prisma.AlertEventGetPayload<{
  include: typeof WITH_RULE_PERMISSION;
}>;

@Injectable()
export class AlertEventsPrismaRepository implements AlertEventsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<AlertEvent | null> {
    const record = await this.prisma.alertEvent.findUnique({
      where: { id },
      include: WITH_RULE_PERMISSION,
    });
    return record ? toEntity(record) : null;
  }

  async list(
    filter: ListAlertEventsFilter,
    page: PageParams,
  ): Promise<PageResult<AlertEvent>> {
    if (filter.permissions.length === 0) {
      return { items: [], total: 0, ...page };
    }

    const where: Prisma.AlertEventWhereInput = {
      rule: { requiredPermission: { in: [...filter.permissions] } },
      acknowledgedAt:
        filter.acknowledged === undefined
          ? undefined
          : filter.acknowledged
            ? { not: null }
            : null,
    };

    const [records, total] = await Promise.all([
      this.prisma.alertEvent.findMany({
        where,
        include: WITH_RULE_PERMISSION,
        orderBy: { createdAt: 'desc' },
        skip: offsetOf(page),
        take: page.pageSize,
      }),
      this.prisma.alertEvent.count({ where }),
    ]);

    return { items: records.map(toEntity), total, ...page };
  }

  /**
   * Condicionado a `acknowledgedAt IS NULL`: dois operadores reconhecendo ao
   * mesmo tempo não sobrescrevem um ao outro — vale o primeiro.
   */
  async saveAcknowledgement(event: AlertEvent): Promise<void> {
    await this.prisma.alertEvent.updateMany({
      where: { id: event.id, acknowledgedAt: null },
      data: {
        acknowledgedBy: event.acknowledgedBy,
        acknowledgedAt: event.acknowledgedAt,
      },
    });
  }
}

function toEntity(record: AlertEventWithRule): AlertEvent {
  return AlertEvent.restore({
    id: record.id,
    ruleId: record.ruleId,
    requiredPermission: record.rule.requiredPermission,
    source: record.source,
    severity: record.severity,
    payload: record.payload,
    acknowledgedBy: record.acknowledgedBy,
    acknowledgedAt: record.acknowledgedAt,
    createdAt: record.createdAt,
  });
}
