import { Injectable } from '@nestjs/common';
import type { AlertRule as AlertRuleRecord } from 'generated/prisma/client';
import { AlertChannel, AlertRule } from 'src/modules/alerts/domain/entities';
import { AlertRulesRepositoryInterface } from 'src/modules/alerts/domain/ports';
import { toNullablePrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AlertRulesPrismaRepository implements AlertRulesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(rule: AlertRule): Promise<void> {
    await this.prisma.alertRule.create({
      data: { id: rule.id, createdAt: rule.createdAt, ...toData(rule) },
    });
  }

  async update(rule: AlertRule): Promise<void> {
    await this.prisma.alertRule.update({
      where: { id: rule.id },
      data: toData(rule),
    });
  }

  async findById(id: string): Promise<AlertRule | null> {
    const record = await this.prisma.alertRule.findUnique({ where: { id } });
    return record ? toEntity(record) : null;
  }

  async list(): Promise<AlertRule[]> {
    const records = await this.prisma.alertRule.findMany({
      orderBy: [{ source: 'asc' }, { createdAt: 'desc' }],
    });
    return records.map(toEntity);
  }
}

function toData(rule: AlertRule) {
  return {
    source: rule.source,
    threshold: rule.threshold,
    channel: rule.channel,
    target: rule.target,
    requiredPermission: rule.requiredPermission,
    quietHours: toNullablePrismaJson(rule.quietHours),
    active: rule.active,
    updatedAt: rule.updatedAt,
  };
}

function toEntity(record: AlertRuleRecord): AlertRule {
  return AlertRule.restore({
    id: record.id,
    source: record.source,
    threshold: record.threshold,
    channel: record.channel as AlertChannel,
    target: record.target,
    requiredPermission: record.requiredPermission,
    quietHours: record.quietHours,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
