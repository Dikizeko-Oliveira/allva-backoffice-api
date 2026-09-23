import { Injectable } from '@nestjs/common';
import type { SavedView as SavedViewRecord } from 'generated/prisma/client';
import { SavedView } from 'src/modules/preferences/domain/entities';
import { SavedViewsRepositoryInterface } from 'src/modules/preferences/domain/ports';
import {
  toNullablePrismaJson,
  toPrismaJson,
} from 'src/shared/infrastructure/database/prisma/json';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class SavedViewsPrismaRepository implements SavedViewsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(view: SavedView): Promise<void> {
    await this.prisma.savedView.create({
      data: {
        id: view.id,
        operatorId: view.operatorId,
        screen: view.screen,
        createdAt: view.createdAt,
        ...toData(view),
      },
    });
  }

  async update(view: SavedView): Promise<void> {
    await this.prisma.savedView.update({
      where: { id: view.id },
      data: toData(view),
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.savedView.delete({ where: { id } });
  }

  async findById(id: string): Promise<SavedView | null> {
    const record = await this.prisma.savedView.findUnique({ where: { id } });
    return record ? toEntity(record) : null;
  }

  async listVisibleTo(
    operatorId: string,
    screen?: string,
  ): Promise<SavedView[]> {
    const records = await this.prisma.savedView.findMany({
      where: { screen, OR: [{ operatorId }, { shared: true }] },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    return records.map(toEntity);
  }
}

function toData(view: SavedView) {
  return {
    name: view.name,
    filters: toPrismaJson(view.filters),
    columns: toPrismaJson(view.columns),
    sort: toNullablePrismaJson(view.sort),
    isDefault: view.isDefault,
    shared: view.shared,
    updatedAt: view.updatedAt,
  };
}

function toEntity(record: SavedViewRecord): SavedView {
  return SavedView.restore({
    id: record.id,
    operatorId: record.operatorId,
    screen: record.screen,
    name: record.name,
    filters: record.filters,
    columns: record.columns,
    sort: record.sort,
    isDefault: record.isDefault,
    shared: record.shared,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
