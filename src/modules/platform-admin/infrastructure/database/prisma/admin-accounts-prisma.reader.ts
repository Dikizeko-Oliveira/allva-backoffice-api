import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { PLATFORM_ROLES } from 'src/modules/accounts/domain/platform-rbac';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import type {
  AdminAccountDetail,
  AdminCustomerFilters,
  AdminCustomerMembershipRow,
  AdminOperatorFilters,
  AdminOperatorRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import { AdminAccountsReaderInterface } from 'src/modules/platform-admin/domain/ports';

type RoleFilter = Prisma.EnumACCOUNT_ROLE_TYPEFilter['in'];

/**
 * Contas vistas pela plataforma.
 *
 * **Conta anonimizada não aparece.** `deleted_at` em `accounts` é o apagamento
 * a pedido do titular — o dado pessoal já foi embora, e listar a casca só
 * confundiria quem procura um cliente.
 *
 * "Visto por último" é a sessão mais recentemente renovada da conta: o que o
 * banco tem de mais próximo de atividade sem instrumentar cada requisição.
 */
@Injectable()
export class AdminAccountsPrismaReader implements AdminAccountsReaderInterface {
  constructor(private readonly prisma: PrismaService) {}

  async listCustomers(
    filters: AdminCustomerFilters,
  ): Promise<Page<AdminCustomerMembershipRow>> {
    const q = filters.q?.trim();
    const where: Prisma.OrganizationUserWhereInput = {
      deletedAt: null,
      organization: { is: { deletedAt: null } },
      user: { is: { deletedAt: null, role: 'USER' } },
      ...(filters.status && {
        status:
          filters.status as Prisma.EnumOrganizationUserStatusFilter['equals'],
      }),
      ...(filters.organizationId && { organizationId: filters.organizationId }),
      ...(filters.plan && {
        organization: {
          is: {
            deletedAt: null,
            subscription: {
              is: { plan: { is: { type: filters.plan as PlanType } } },
            },
          },
        },
      }),
      ...(q && {
        OR: [
          { accountId: q },
          { user: { is: { name: { contains: q, mode: 'insensitive' } } } },
          { user: { is: { email: { contains: q, mode: 'insensitive' } } } },
          {
            organization: {
              is: { name: { contains: q, mode: 'insensitive' } },
            },
          },
        ],
      }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.organizationUser.count({ where }),
      this.prisma.organizationUser.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              emailVerified: true,
            },
          },
          organization: {
            select: {
              id: true,
              name: true,
              subscription: { select: { plan: { select: { type: true } } } },
            },
          },
        },
        orderBy: [{ user: { name: 'asc' } }, { createdAt: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    const lastSeen = await this.lastSeenFor(rows.map((row) => row.accountId));

    return {
      items: rows.map((row) => ({
        membershipId: row.id,
        accountId: row.user.id,
        name: row.user.name,
        email: row.user.email,
        emailVerified: row.user.emailVerified,
        status: row.status,
        organization: { id: row.organization.id, name: row.organization.name },
        organizationRole: row.role,
        planType: row.organization.subscription?.plan.type ?? null,
        lastSeenAt: lastSeen.get(row.accountId) ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async listOperators(
    filters: AdminOperatorFilters & { roles?: readonly string[] },
  ): Promise<Page<AdminOperatorRow>> {
    const q = filters.q?.trim();
    const allowed = (filters.roles ?? PLATFORM_ROLES).filter(
      (role) => !filters.platformRole || role === filters.platformRole,
    );

    const where: Prisma.AccountWhereInput = {
      deletedAt: null,
      role: { in: allowed as RoleFilter },
      ...(filters.status === 'ACTIVE' && { platformSuspendedAt: null }),
      ...(filters.status === 'DISABLED' && {
        platformSuspendedAt: { not: null },
      }),
      ...(q && {
        OR: [
          { id: q },
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.account.count({ where }),
      this.prisma.account.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          role: true,
          platformSuspendedAt: true,
          createdAt: true,
        },
        orderBy: { name: 'asc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    const lastSeen = await this.lastSeenFor(rows.map((row) => row.id));

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        emailVerified: row.emailVerified,
        platformRole: row.role,
        status: row.platformSuspendedAt ? 'DISABLED' : 'ACTIVE',
        lastSeenAt: lastSeen.get(row.id) ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async findById(id: string): Promise<AdminAccountDetail | null> {
    const account = await this.prisma.account.findFirst({
      where: { id, deletedAt: null },
      include: {
        organizationUsers: {
          where: {
            deletedAt: null,
            organization: { is: { deletedAt: null } },
          },
          include: { organization: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!account) return null;

    const lastSeen = await this.lastSeenFor([account.id]);

    return {
      id: account.id,
      name: account.name,
      email: account.email,
      emailVerified: account.emailVerified,
      platformRole: account.role === 'USER' ? null : account.role,
      cpf: account.cpf,
      phone: account.phone,
      address: account.address,
      addressNumber: account.addressNumber,
      addressComplement: account.addressComplement,
      addressCity: account.addressCity,
      avatarUrl: account.avatarUrl,
      lastSeenAt: lastSeen.get(account.id) ?? null,
      createdAt: account.createdAt.toISOString(),
      memberships: account.organizationUsers.map((membership) => ({
        membershipId: membership.id,
        organization: membership.organization,
        role: membership.role,
        status: membership.status,
        createdAt: membership.createdAt.toISOString(),
      })),
    };
  }

  private async lastSeenFor(
    accountIds: string[],
  ): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();

    const groups = await this.prisma.session.groupBy({
      by: ['accountId'],
      where: { accountId: { in: [...new Set(accountIds)] } },
      _max: { updatedAt: true },
    });

    return new Map(
      groups
        .filter((group) => group._max.updatedAt)
        .map((group) => [group.accountId, group._max.updatedAt!.toISOString()]),
    );
  }
}
