import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import {
  billingStatusesFor,
  organizationStatusOf,
} from 'src/modules/platform-admin/domain/organization-status';
import type {
  AdminInvoiceFilters,
  AdminInvoiceRow,
  AdminSubscriptionFilters,
  AdminSubscriptionRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import { AdminBillingReaderInterface } from 'src/modules/platform-admin/domain/ports';

const LIVE_CONTRACT_STATUSES = [
  'SIGNED',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
] as const;

/** Pagamento que conta como baixa. */
const SETTLED_PAYMENT_STATUSES = ['APPROVED', 'AUTHORIZED'] as const;

/**
 * Assinaturas e faturas vistas pela plataforma.
 *
 * **Assinatura é a da organização** (`organization_subscriptions`), a que
 * decide acesso. A tabela `subscriptions`, por conta, é o legado do checkout e
 * aparece aqui só através das faturas que ela emitiu.
 */
@Injectable()
export class AdminBillingPrismaReader implements AdminBillingReaderInterface {
  constructor(private readonly prisma: PrismaService) {}

  async listSubscriptions(
    filters: AdminSubscriptionFilters,
  ): Promise<Page<AdminSubscriptionRow>> {
    const q = filters.q?.trim();
    const where: Prisma.OrganizationSubscriptionWhereInput = {
      organization: {
        is: {
          deletedAt: null,
          ...(q && {
            OR: [
              { id: q },
              { name: { contains: q, mode: 'insensitive' } },
              { cnpj: { contains: q } },
            ],
          }),
        },
      },
      ...(filters.status &&
        filters.status !== 'NO_SUBSCRIPTION' && {
          status: {
            in: billingStatusesFor(
              filters.status,
            ) as Prisma.EnumBillingStatusFilter['in'],
          },
        }),
      ...(filters.plan && {
        plan: { is: { type: filters.plan as PlanType } },
      }),
    };

    if (filters.status === 'NO_SUBSCRIPTION') {
      // Uma assinatura não pode estar "sem assinatura": o recorte é vazio.
      return {
        items: [],
        total: 0,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.organizationSubscription.count({ where }),
      this.prisma.organizationSubscription.findMany({
        where,
        include: {
          plan: { select: { type: true, name: true, amount: true } },
          pendingPlan: { select: { type: true } },
          organization: {
            select: {
              id: true,
              name: true,
              contracts: {
                where: { status: { in: [...LIVE_CONTRACT_STATUSES] } },
                select: {
                  id: true,
                  contractNumber: true,
                  startsAt: true,
                  endsAt: true,
                  billingInterval: true,
                  billingAmount: true,
                  currency: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    const now = new Date();

    return {
      items: rows.map((row) => {
        const contract = selectGoverningContract(
          row.organization.contracts,
          now,
        );
        const monthlyAmount = contract
          ? contract.billingInterval === 'ANNUAL'
            ? round2(Number(contract.billingAmount) / 12)
            : Number(contract.billingAmount)
          : (row.plan.amount ?? null);

        return {
          id: row.id,
          organization: {
            id: row.organization.id,
            name: row.organization.name,
          },
          status: organizationStatusOf(row.status),
          billingStatus: row.status,
          planType: row.plan.type,
          planName: row.plan.name,
          source: contract ? ('CONTRACT' as const) : ('SELF_SERVICE' as const),
          contractId: contract?.id ?? null,
          contractNumber: contract?.contractNumber ?? null,
          monthlyAmount,
          currency: contract?.currency ?? 'BRL',
          trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
          pendingPlanType: row.pendingPlan?.type ?? null,
          pendingPlanEffectiveAt:
            row.pendingPlanEffectiveAt?.toISOString() ?? null,
          startedAt: row.createdAt.toISOString(),
        };
      }),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async listInvoices(
    filters: AdminInvoiceFilters,
    now: Date,
  ): Promise<Page<AdminInvoiceRow>> {
    const q = filters.q?.trim();
    const and: Prisma.InvoiceWhereInput[] = [];

    if (filters.status) {
      and.push({
        status: filters.status as Prisma.EnumInvoiceStatusFilter['equals'],
      });
    }
    if (filters.overdue) {
      and.push({ status: 'PENDING', dueAt: { lt: now } });
    }
    if (filters.organizationId) {
      and.push(this.belongsTo(filters.organizationId));
    }
    if (q) {
      and.push({
        OR: [
          { number: { contains: q, mode: 'insensitive' } },
          { externalInvoiceId: { contains: q } },
          { account: { is: { email: { contains: q, mode: 'insensitive' } } } },
          {
            contract: {
              is: {
                organization: {
                  is: { name: { contains: q, mode: 'insensitive' } },
                },
              },
            },
          },
          {
            account: {
              is: {
                ownedOrganizations: {
                  some: { name: { contains: q, mode: 'insensitive' } },
                },
              },
            },
          },
        ],
      });
    }

    const where: Prisma.InvoiceWhereInput = and.length ? { AND: and } : {};

    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: {
          account: {
            select: {
              id: true,
              name: true,
              email: true,
              ownedOrganizations: {
                where: { deletedAt: null },
                select: { id: true, name: true },
                orderBy: { createdAt: 'asc' },
                take: 1,
              },
            },
          },
          contract: {
            select: {
              id: true,
              contractNumber: true,
              organization: { select: { id: true, name: true } },
            },
          },
          payments: {
            where: { status: { in: [...SETTLED_PAYMENT_STATUSES] } },
            select: { paidAt: true },
            orderBy: { paidAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        number: row.number,
        status: row.status,
        overdue:
          row.status === 'PENDING' && row.dueAt !== null && row.dueAt < now,
        amount: Number(row.amount),
        currency: row.currency,
        provider: row.provider,
        externalInvoiceId: row.externalInvoiceId,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        dueAt: row.dueAt?.toISOString() ?? null,
        paidAt:
          row.payments[0]?.paidAt?.toISOString() ??
          (row.status === 'PAID' ? row.updatedAt.toISOString() : null),
        createdAt: row.createdAt.toISOString(),
        // Fatura de contrato pertence à organização do contrato; a de
        // autoatendimento, à organização que a conta pagante possui.
        organization:
          row.contract?.organization ??
          row.account.ownedOrganizations[0] ??
          null,
        contract: row.contract
          ? { id: row.contract.id, contractNumber: row.contract.contractNumber }
          : null,
        account: {
          id: row.account.id,
          name: row.account.name,
          email: row.account.email,
        },
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  private belongsTo(organizationId: string): Prisma.InvoiceWhereInput {
    return {
      OR: [
        { contract: { is: { organizationId } } },
        {
          contractId: null,
          account: {
            is: { ownedOrganizations: { some: { id: organizationId } } },
          },
        },
      ],
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
