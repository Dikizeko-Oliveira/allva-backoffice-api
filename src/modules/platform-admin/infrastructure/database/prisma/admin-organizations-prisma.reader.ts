import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { linkedAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import { resolveSeatLimit } from 'src/modules/organizations/domain/plan-seat-limits';
import { effectiveQuota } from 'src/modules/plans/domain/plan-entitlements';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import {
  billingStatusesFor,
  organizationStatusOf,
} from 'src/modules/platform-admin/domain/organization-status';
import type {
  AdminOrganizationDetail,
  AdminOrganizationFilters,
  AdminOrganizationRow,
  Page,
  QuotaDimension,
  QuotaLine,
} from 'src/modules/platform-admin/domain/read-models';
import { AdminOrganizationsReaderInterface } from 'src/modules/platform-admin/domain/ports';

const LIVE_CONTRACT_STATUSES = [
  'SIGNED',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
] as const;

const ORGANIZATION_INCLUDE = {
  owner: { select: { id: true, name: true, email: true } },
  subscription: { include: { plan: { select: { type: true, name: true } } } },
  quota: true,
} satisfies Prisma.OrganizationInclude;

type OrganizationRow = Prisma.OrganizationGetPayload<{
  include: typeof ORGANIZATION_INCLUDE;
}>;

type Usage = Record<QuotaDimension, number>;

/**
 * Organizações vistas pela plataforma.
 *
 * Os tetos saem das **mesmas funções** que o produto usa para recusar:
 * `resolveSeatLimit` (assentos, como `SeatLimitService`) e `effectiveQuota`
 * (o resto, como `PlanEntitlementService`). Uma tabela de tetos só do painel
 * mostraria ao operador um limite diferente do que o cliente bate.
 *
 * O uso também: assento é membro ativo mais convite pendente, conta de anúncio
 * é a vinculada a credencial viva, anúncio monitorado é o elegível à análise.
 * Tudo contado por página (no máximo `pageSize` organizações), em consultas
 * agrupadas — nunca uma por organização.
 */
@Injectable()
export class AdminOrganizationsPrismaReader implements AdminOrganizationsReaderInterface {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filters: AdminOrganizationFilters,
  ): Promise<Page<AdminOrganizationRow>> {
    const where = this.whereFor(filters);

    const [total, rows] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({
        where,
        include: ORGANIZATION_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    const items = await this.present(rows);

    return { items, total, page: filters.page, pageSize: filters.pageSize };
  }

  async findById(id: string): Promise<AdminOrganizationDetail | null> {
    const row = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: ORGANIZATION_INCLUDE,
    });

    if (!row) return null;

    const [[summary], usage, activeMembers, pendingInvitations] =
      await Promise.all([
        this.present([row]),
        this.usageFor([row]),
        this.countActiveMembers([row.id]),
        this.countPendingInvitations([row.id]),
      ]);

    return {
      ...summary,
      phone: row.phone,
      address: row.address,
      addressNumber: row.addressNumber,
      addressComplement: row.addressComplement,
      addressCity: row.addressCity,
      nameConfirmedAt: row.nameConfirmedAt?.toISOString() ?? null,
      accessClosedAt: row.accessClosedAt?.toISOString() ?? null,
      members: {
        active: activeMembers.get(row.id) ?? 0,
        pendingInvitations: pendingInvitations.get(row.id) ?? 0,
      },
      quotas: this.quotaLines(row, usage.get(row.id)!),
    };
  }

  private whereFor(
    filters: AdminOrganizationFilters,
  ): Prisma.OrganizationWhereInput {
    const and: Prisma.OrganizationWhereInput[] = [{ deletedAt: null }];
    const q = filters.q?.trim();

    if (q) {
      and.push({
        OR: [
          { id: q },
          { name: { contains: q, mode: 'insensitive' } },
          { cnpj: { contains: q } },
          { owner: { is: { name: { contains: q, mode: 'insensitive' } } } },
          { owner: { is: { email: { contains: q, mode: 'insensitive' } } } },
        ],
      });
    }

    if (filters.status === 'NO_SUBSCRIPTION') {
      and.push({ subscription: { is: null } });
    } else if (filters.status) {
      and.push({
        subscription: {
          is: {
            status: {
              in: billingStatusesFor(
                filters.status,
              ) as Prisma.EnumBillingStatusFilter['in'],
            },
          },
        },
      });
    }

    if (filters.plan) {
      and.push({
        subscription: {
          is: { plan: { is: { type: filters.plan as PlanType } } },
        },
      });
    }

    return { AND: and };
  }

  private async present(
    rows: OrganizationRow[],
  ): Promise<AdminOrganizationRow[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const now = new Date();

    const [usage, contracts, integrations] = await Promise.all([
      this.usageFor(rows),
      this.prisma.enterpriseContract.findMany({
        where: { organizationId: { in: ids } },
        select: {
          id: true,
          organizationId: true,
          salesLeadId: true,
          status: true,
          startsAt: true,
          endsAt: true,
        },
      }),
      this.prisma.integration.findMany({
        where: { organizationId: { in: ids } },
        select: {
          organizationId: true,
          provider: true,
          status: true,
          lastSyncAt: true,
        },
      }),
    ]);

    return rows.map((row) => {
      const planType = (row.subscription?.plan.type ?? null) as PlanType | null;
      const overrides = row.quota;
      const used = usage.get(row.id)!;
      const own = contracts.filter((c) => c.organizationId === row.id);
      const live = own.filter((c) =>
        (LIVE_CONTRACT_STATUSES as readonly string[]).includes(c.status),
      );
      const current =
        selectGoverningContract(live, now) ??
        [...own].sort(
          (a, b) => b.startsAt.getTime() - a.startsAt.getTime(),
        )[0] ??
        null;
      const ownIntegrations = integrations.filter(
        (i) => i.organizationId === row.id,
      );
      const lastSync = ownIntegrations
        .map((i) => i.lastSyncAt)
        .filter((date): date is Date => date !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      return {
        id: row.id,
        name: row.name,
        cnpj: row.cnpj,
        status: organizationStatusOf(row.subscription?.status),
        billingStatus: row.subscription?.status ?? null,
        planType,
        planName: row.subscription?.plan.name ?? null,
        trialEndsAt: row.subscription?.trialEndsAt?.toISOString() ?? null,
        origin: own.length > 0 ? 'CONTRACT' : 'SELF_SERVICE',
        owner: row.owner,
        baseCurrency: row.baseCurrency,
        currentContractId: current?.id ?? null,
        salesLeadId: current?.salesLeadId ?? null,
        connectedPlatforms: [
          ...new Set(
            ownIntegrations
              .filter((i) => i.status === 'CONNECTED')
              .map((i) => i.provider),
          ),
        ].sort(),
        seats: {
          used: used.seats,
          limit: overrides?.maxSeats ?? resolveSeatLimit(planType),
        },
        adAccounts: {
          used: used.adAccounts,
          limit: effectiveQuota(
            planType,
            'ad-accounts',
            overrides?.maxAdAccounts ?? null,
          ),
        },
        monitoredAds: {
          used: used.monitoredAds,
          limit: effectiveQuota(
            planType,
            'monitored-ads',
            overrides?.maxMonitoredAds ?? null,
          ),
        },
        lastSyncAt: lastSync?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private quotaLines(row: OrganizationRow, used: Usage): QuotaLine[] {
    const planType = (row.subscription?.plan.type ?? null) as PlanType | null;
    const overrides = row.quota;

    const line = (
      dimension: QuotaDimension,
      negotiated: number | null,
      planCeiling: number | null,
    ): QuotaLine => ({
      dimension,
      used: used[dimension],
      negotiated,
      planCeiling,
      effective: negotiated ?? planCeiling,
    });

    return [
      line('seats', overrides?.maxSeats ?? null, resolveSeatLimit(planType)),
      line(
        'adAccounts',
        overrides?.maxAdAccounts ?? null,
        effectiveQuota(planType, 'ad-accounts', null),
      ),
      line(
        'monitoredAds',
        overrides?.maxMonitoredAds ?? null,
        effectiveQuota(planType, 'monitored-ads', null),
      ),
      line(
        'organizations',
        overrides?.maxOrganizations ?? null,
        effectiveQuota(planType, 'organizations', null),
      ),
    ];
  }

  private async usageFor(rows: OrganizationRow[]): Promise<Map<string, Usage>> {
    const ids = rows.map((row) => row.id);
    const ownerIds = [...new Set(rows.map((row) => row.ownerId))];

    const [members, invitations, adAccounts, monitoredAds, ownedOrganizations] =
      await Promise.all([
        this.countActiveMembers(ids),
        this.countPendingInvitations(ids),
        this.prisma.adAccount.groupBy({
          by: ['organizationId'],
          where: {
            organizationId: { in: ids },
            ...linkedAdAccountWhere(),
            OR: [{ frozenAt: null }, { frozenAt: { gt: new Date() } }],
          },
          _count: { _all: true },
        }),
        this.prisma.ad.groupBy({
          by: ['organizationId'],
          where: {
            organizationId: { in: ids },
            archivedAt: null,
            analysisEligibleAt: { not: null },
            adAccount: { is: linkedAdAccountWhere() },
          },
          _count: { _all: true },
        }),
        this.prisma.organization.groupBy({
          by: ['ownerId'],
          where: { ownerId: { in: ownerIds }, deletedAt: null },
          _count: { _all: true },
        }),
      ]);

    const countOf = (
      groups: { organizationId: string; _count: { _all: number } }[],
      id: string,
    ) => groups.find((group) => group.organizationId === id)?._count._all ?? 0;

    return new Map(
      rows.map((row) => [
        row.id,
        {
          seats: (members.get(row.id) ?? 0) + (invitations.get(row.id) ?? 0),
          adAccounts: countOf(adAccounts, row.id),
          monitoredAds: countOf(monitoredAds, row.id),
          organizations:
            ownedOrganizations.find((group) => group.ownerId === row.ownerId)
              ?._count._all ?? 0,
        },
      ]),
    );
  }

  private async countActiveMembers(
    ids: string[],
  ): Promise<Map<string, number>> {
    const groups = await this.prisma.organizationUser.groupBy({
      by: ['organizationId'],
      where: {
        organizationId: { in: ids },
        status: 'ACTIVE',
        deletedAt: null,
        // O mesmo predicado de `OrganizationUser.isActive()`: congelamento
        // agendado para o futuro ainda é membro ativo.
        OR: [{ frozenAt: null }, { frozenAt: { gt: new Date() } }],
      },
      _count: { _all: true },
    });

    return new Map(groups.map((g) => [g.organizationId, g._count._all]));
  }

  private async countPendingInvitations(
    ids: string[],
  ): Promise<Map<string, number>> {
    const groups = await this.prisma.organizationInvitation.groupBy({
      by: ['organizationId'],
      where: {
        organizationId: { in: ids },
        acceptedAt: null,
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: new Date() },
      },
      _count: { _all: true },
    });

    return new Map(groups.map((g) => [g.organizationId, g._count._all]));
  }
}
