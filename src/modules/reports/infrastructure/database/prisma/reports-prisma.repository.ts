import { Injectable } from '@nestjs/common';
import {
  ReportDTO,
  ReportInput,
  ReportStatus,
  ReportsRepositoryInterface,
} from 'src/modules/reports/domain/ports/reports.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class ReportsPrismaRepository implements ReportsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  private toDTO(r: Record<string, unknown>): ReportDTO {
    return {
      id: r.id as string,
      accountId: r.accountId as string,
      organizationId: (r.organizationId as string) ?? null,
      templateKey: r.templateKey as string,
      status: r.status as ReportStatus,
      params: (r.params as Record<string, unknown>) ?? null,
      storageProvider: (r.storageProvider as string) ?? null,
      storageKey: (r.storageKey as string) ?? null,
      downloadUrl: (r.downloadUrl as string) ?? null,
      errorMessage: (r.errorMessage as string) ?? null,
      generatedAt: (r.generatedAt as Date) ?? null,
      emailedAt: (r.emailedAt as Date) ?? null,
      createdAt: r.createdAt as Date,
    };
  }

  async create(input: ReportInput): Promise<ReportDTO> {
    const row = (await this.prisma.report.create({
      data: {
        accountId: input.accountId,
        organizationId: input.organizationId ?? null,
        templateKey: input.templateKey,
        status: 'PENDING',
        params: (input.params as object) ?? null,
      } as never,
    })) as unknown as Record<string, unknown>;
    return this.toDTO(row);
  }

  async findById(
    id: string,
    scope: { accountId: string; organizationId?: string | null },
  ): Promise<ReportDTO | null> {
    const where = scope.organizationId
      ? { id, organizationId: scope.organizationId }
      : { id, accountId: scope.accountId };
    const row = (await this.prisma.report.findFirst({
      where: where as never,
    })) as unknown as Record<string, unknown> | null;
    return row ? this.toDTO(row) : null;
  }

  async findByIdInternal(id: string): Promise<ReportDTO | null> {
    const row = (await this.prisma.report.findUnique({
      where: { id },
    })) as unknown as Record<string, unknown> | null;
    return row ? this.toDTO(row) : null;
  }

  async list(scope: {
    accountId: string;
    organizationId?: string | null;
  }): Promise<ReportDTO[]> {
    const where = scope.organizationId
      ? { organizationId: scope.organizationId }
      : { accountId: scope.accountId };
    const rows = (await this.prisma.report.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' } as never,
    })) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => this.toDTO(r));
  }

  async updateStatus(
    id: string,
    status: ReportStatus,
    options?: {
      storageProvider?: string | null;
      storageKey?: string | null;
      downloadUrl?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<ReportDTO> {
    const data: Record<string, unknown> = { status };
    if (status === 'READY') data.generatedAt = new Date();
    if (options?.storageProvider !== undefined)
      data.storageProvider = options.storageProvider;
    if (options?.storageKey !== undefined) data.storageKey = options.storageKey;
    if (options?.downloadUrl !== undefined)
      data.downloadUrl = options.downloadUrl;
    if (options?.errorMessage !== undefined)
      data.errorMessage = options.errorMessage;
    const row = (await this.prisma.report.update({
      where: { id },
      data: data as never,
    })) as unknown as Record<string, unknown>;
    return this.toDTO(row);
  }

  async markEmailed(id: string): Promise<ReportDTO> {
    const row = (await this.prisma.report.update({
      where: { id },
      data: { emailedAt: new Date() } as never,
    })) as unknown as Record<string, unknown>;
    return this.toDTO(row);
  }
}
