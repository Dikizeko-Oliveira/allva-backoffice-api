import { Injectable } from '@nestjs/common';
import type { SlaPolicy as SlaPolicyRecord } from 'generated/prisma/client';
import { SlaPolicy } from 'src/modules/support/domain/entities';
import { SlaPoliciesRepositoryInterface } from 'src/modules/support/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class SlaPoliciesPrismaRepository implements SlaPoliciesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(policy: SlaPolicy): Promise<void> {
    await this.prisma.slaPolicy.create({
      data: {
        id: policy.id,
        ...this.toData(policy),
        createdAt: policy.createdAt,
      },
    });
  }

  async update(policy: SlaPolicy): Promise<void> {
    await this.prisma.slaPolicy.update({
      where: { id: policy.id },
      data: this.toData(policy),
    });
  }

  async findById(id: string): Promise<SlaPolicy | null> {
    const record = await this.prisma.slaPolicy.findUnique({ where: { id } });
    return record ? toEntity(record) : null;
  }

  async list(): Promise<SlaPolicy[]> {
    const records = await this.prisma.slaPolicy.findMany({
      orderBy: [
        { priority: 'asc' },
        { category: { sort: 'asc', nulls: 'first' } },
      ],
    });
    return records.map(toEntity);
  }

  async listActive(): Promise<SlaPolicy[]> {
    const records = await this.prisma.slaPolicy.findMany({
      where: { active: true },
    });
    return records.map(toEntity);
  }

  async findActiveByScope(
    priority: string,
    category: string | null,
  ): Promise<SlaPolicy | null> {
    const record = await this.prisma.slaPolicy.findFirst({
      where: { active: true, priority, category },
    });
    return record ? toEntity(record) : null;
  }

  private toData(policy: SlaPolicy) {
    return {
      priority: policy.priority,
      category: policy.category,
      firstResponseMinutes: policy.firstResponseMinutes,
      resolutionMinutes: policy.resolutionMinutes,
      businessHours: policy.businessHours,
      active: policy.active,
      updatedAt: policy.updatedAt,
    };
  }
}

function toEntity(record: SlaPolicyRecord): SlaPolicy {
  return SlaPolicy.restore({
    id: record.id,
    priority: record.priority,
    category: record.category,
    firstResponseMinutes: record.firstResponseMinutes,
    resolutionMinutes: record.resolutionMinutes,
    businessHours: record.businessHours,
    active: record.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
