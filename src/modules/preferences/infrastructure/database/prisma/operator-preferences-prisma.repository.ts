import { Injectable } from '@nestjs/common';
import { OperatorPreference } from 'src/modules/preferences/domain/entities';
import { OperatorPreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class OperatorPreferencesPrismaRepository implements OperatorPreferencesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findByOperatorId(
    operatorId: string,
  ): Promise<OperatorPreference | null> {
    const record = await this.prisma.operatorPreference.findUnique({
      where: { operatorId },
    });

    if (!record) return null;

    return OperatorPreference.restore({
      operatorId: record.operatorId,
      lastWorkspace: record.lastWorkspace,
      sidebarCollapsed: record.sidebarCollapsed,
      density: record.density,
      timezone: record.timezone,
      updatedAt: record.updatedAt,
    });
  }

  async save(preference: OperatorPreference): Promise<void> {
    const data = {
      lastWorkspace: preference.lastWorkspace,
      sidebarCollapsed: preference.sidebarCollapsed,
      density: preference.density,
      timezone: preference.timezone,
      updatedAt: preference.updatedAt ?? new Date(),
    };

    await this.prisma.operatorPreference.upsert({
      where: { operatorId: preference.operatorId },
      create: { operatorId: preference.operatorId, ...data },
      update: data,
    });
  }
}
