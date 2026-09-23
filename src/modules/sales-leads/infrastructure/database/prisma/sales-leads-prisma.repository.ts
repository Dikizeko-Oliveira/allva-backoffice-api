import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { SalesLead, SalesLeadStatus } from '../../../domain/entities';
import {
  ListSalesLeadsFilter,
  ListSalesLeadsResult,
  SalesLeadsRepositoryInterface,
} from '../../../domain/ports';

type SalesLeadRow = {
  id: string;
  accountId: string | null;
  companyName: string;
  workEmail: string;
  fullName: string;
  phone: string | null;
  estimatedMonthlySpend: { toString(): string } | number | null;
  teamSize: number | null;
  platforms: unknown;
  notes: string | null;
  desiredPlan: string;
  status: string;
  source: string | null;
  assignedTo: string | null;
  qualifiedAt: Date | null;
  closedWonAt: Date | null;
  closedLostAt: Date | null;
  metadata: unknown;
  provisionedOrganizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class SalesLeadsPrismaRepository implements SalesLeadsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(row: SalesLeadRow): SalesLead {
    return SalesLead.restore({
      id: row.id,
      accountId: row.accountId,
      companyName: row.companyName,
      workEmail: row.workEmail,
      fullName: row.fullName,
      phone: row.phone,
      estimatedMonthlySpend:
        row.estimatedMonthlySpend === null
          ? null
          : Number(row.estimatedMonthlySpend),
      teamSize: row.teamSize,
      platforms: (row.platforms as string[] | null) ?? null,
      notes: row.notes,
      desiredPlan: row.desiredPlan,
      status: row.status as SalesLeadStatus,
      source: row.source,
      assignedTo: row.assignedTo,
      qualifiedAt: row.qualifiedAt,
      closedWonAt: row.closedWonAt,
      closedLostAt: row.closedLostAt,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      provisionedOrganizationId: row.provisionedOrganizationId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async save(salesLead: SalesLead): Promise<void> {
    await this.prisma.salesLead.create({
      data: {
        id: salesLead.id,
        accountId: salesLead.accountId,
        companyName: salesLead.companyName,
        workEmail: salesLead.workEmail,
        fullName: salesLead.fullName,
        phone: salesLead.phone,
        estimatedMonthlySpend: salesLead.estimatedMonthlySpend,
        teamSize: salesLead.teamSize,
        platforms: salesLead.platforms ?? undefined,
        notes: salesLead.notes,
        desiredPlan: salesLead.desiredPlan,
        status: salesLead.status,
        source: salesLead.source,
        assignedTo: salesLead.assignedTo,
        qualifiedAt: salesLead.qualifiedAt,
        closedWonAt: salesLead.closedWonAt,
        closedLostAt: salesLead.closedLostAt,
        metadata: salesLead.metadata ?? undefined,
        createdAt: salesLead.createdAt,
        updatedAt: salesLead.updatedAt,
      } as never,
    });
  }

  async update(salesLead: SalesLead): Promise<void> {
    await this.prisma.salesLead.update({
      where: { id: salesLead.id },
      data: {
        status: salesLead.status,
        assignedTo: salesLead.assignedTo,
        qualifiedAt: salesLead.qualifiedAt,
        closedWonAt: salesLead.closedWonAt,
        closedLostAt: salesLead.closedLostAt,
        updatedAt: salesLead.updatedAt,
      } as never,
    });
  }

  async findById(id: string): Promise<SalesLead | null> {
    const record = await this.prisma.salesLead.findUnique({ where: { id } });
    if (!record) return null;
    return this.toEntity(record as unknown as SalesLeadRow);
  }

  async list(filter: ListSalesLeadsFilter): Promise<ListSalesLeadsResult> {
    const q = filter.q?.trim();
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignedTo ? { assignedTo: filter.assignedTo } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.createdFrom || filter.createdTo
        ? {
            createdAt: {
              ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
              ...(filter.createdTo ? { lte: filter.createdTo } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { companyName: { contains: q, mode: 'insensitive' } },
              { fullName: { contains: q, mode: 'insensitive' } },
              { workEmail: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const skip = (filter.page - 1) * filter.pageSize;

    const [records, total] = await Promise.all([
      this.prisma.salesLead.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filter.pageSize,
      }),
      this.prisma.salesLead.count({ where: where as never }),
    ]);

    return {
      items: records.map((record) =>
        this.toEntity(record as unknown as SalesLeadRow),
      ),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }
}
