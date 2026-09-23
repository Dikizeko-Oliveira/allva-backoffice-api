import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type {
  AdminIntegrationFilters,
  AdminIntegrationRow,
  AdminJobRunFilters,
  AdminJobRunRow,
  OrganizationRef,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import { AdminPlatformReaderInterface } from 'src/modules/platform-admin/domain/ports';

/**
 * Integrações e execuções de job vistas pela plataforma.
 *
 * **Nenhum token sai daqui.** `integrations.access_token` e `refresh_token`
 * são cifrados, e mesmo cifrados não têm o que fazer numa tela de operador —
 * a consulta seleciona campo a campo para que um `include` descuidado não os
 * traga um dia.
 */
@Injectable()
export class AdminPlatformPrismaReader implements AdminPlatformReaderInterface {
  constructor(private readonly prisma: PrismaService) {}

  async listIntegrations(
    filters: AdminIntegrationFilters,
  ): Promise<Page<AdminIntegrationRow>> {
    const q = filters.q?.trim();
    const where: Prisma.IntegrationWhereInput = {
      organization: { is: { deletedAt: null } },
      ...(filters.provider && { provider: filters.provider }),
      ...(filters.status && {
        status: filters.status as Prisma.EnumIntegrationStatusFilter['equals'],
      }),
      ...(filters.organizationId && { organizationId: filters.organizationId }),
      ...(q && {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          {
            organization: {
              is: { name: { contains: q, mode: 'insensitive' } },
            },
          },
          {
            adAccounts: {
              some: {
                OR: [
                  { externalAccountId: { contains: q } },
                  { name: { contains: q, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.integration.count({ where }),
      this.prisma.integration.findMany({
        where,
        select: {
          id: true,
          provider: true,
          providerType: true,
          name: true,
          status: true,
          syncStatus: true,
          syncError: true,
          lastSyncAt: true,
          expiresAt: true,
          disconnectedAt: true,
          createdAt: true,
          organization: { select: { id: true, name: true } },
          account: { select: { id: true, name: true, email: true } },
          adAccounts: {
            select: {
              id: true,
              platform: true,
              externalAccountId: true,
              name: true,
              syncHealth: true,
              syncHealthReason: true,
              lastSuccessfulFullSyncAt: true,
            },
            orderBy: { name: 'asc' },
          },
        },
        orderBy: [{ organization: { name: 'asc' } }, { provider: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        organization: row.organization,
        provider: row.provider,
        providerType: row.providerType,
        name: row.name,
        status: row.status,
        syncStatus: row.syncStatus,
        syncError: row.syncError,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
        connectedBy: row.account,
        createdAt: row.createdAt.toISOString(),
        adAccounts: row.adAccounts.map((adAccount) => ({
          ...adAccount,
          lastSuccessfulFullSyncAt:
            adAccount.lastSuccessfulFullSyncAt?.toISOString() ?? null,
        })),
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async listJobRuns(
    filters: AdminJobRunFilters,
    now: Date,
  ): Promise<Page<AdminJobRunRow>> {
    const where: Prisma.JobRunWhereInput = {
      ...(filters.status && {
        status: filters.status as Prisma.EnumJobRunStatusFilter['equals'],
      }),
      ...(filters.jobName && { jobName: filters.jobName }),
      ...(filters.stalled && {
        status: 'RUNNING',
        leaseExpiresAt: { lt: now },
      }),
      ...((filters.from || filters.to) && {
        startedAt: {
          ...(filters.from && { gte: filters.from }),
          ...(filters.to && { lte: filters.to }),
        },
      }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.jobRun.count({ where }),
      this.prisma.jobRun.findMany({
        where,
        select: {
          id: true,
          jobName: true,
          scopeType: true,
          scopeId: true,
          windowKey: true,
          status: true,
          attempt: true,
          startedAt: true,
          leaseExpiresAt: true,
          finishedAt: true,
          durationMs: true,
          processedItems: true,
          successfulItems: true,
          failedItems: true,
          errorMessage: true,
          skipReason: true,
        },
        orderBy: { startedAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    const organizations = await this.organizationsForScopes(rows);

    return {
      items: rows.map(({ leaseExpiresAt, ...row }) => ({
        ...row,
        organization:
          organizations.get(`${row.scopeType}:${row.scopeId}`) ?? null,
        stalled: row.status === 'RUNNING' && leaseExpiresAt < now,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async listJobNames(): Promise<string[]> {
    const groups = await this.prisma.jobRun.groupBy({
      by: ['jobName'],
      orderBy: { jobName: 'asc' },
    });

    return groups.map((group) => group.jobName);
  }

  /**
   * A organização por trás de cada escopo. `GLOBAL` não tem; os outros três
   * chegam lá por uma consulta cada, para a página inteira.
   */
  private async organizationsForScopes(
    rows: { scopeType: string; scopeId: string }[],
  ): Promise<Map<string, OrganizationRef>> {
    const idsOf = (type: string) => [
      ...new Set(
        rows.filter((r) => r.scopeType === type).map((r) => r.scopeId),
      ),
    ];

    const [organizations, adAccounts, integrations] = await Promise.all([
      this.prisma.organization.findMany({
        where: { id: { in: idsOf('ORGANIZATION') } },
        select: { id: true, name: true },
      }),
      this.prisma.adAccount.findMany({
        where: { id: { in: idsOf('AD_ACCOUNT') } },
        select: {
          id: true,
          organization: { select: { id: true, name: true } },
        },
      }),
      this.prisma.integration.findMany({
        where: { id: { in: idsOf('INTEGRATION') } },
        select: {
          id: true,
          organization: { select: { id: true, name: true } },
        },
      }),
    ]);

    return new Map<string, OrganizationRef>([
      ...organizations.map((o) => [`ORGANIZATION:${o.id}`, o] as const),
      ...adAccounts.map((a) => [`AD_ACCOUNT:${a.id}`, a.organization] as const),
      ...integrations.map(
        (i) => [`INTEGRATION:${i.id}`, i.organization] as const,
      ),
    ]);
  }
}
