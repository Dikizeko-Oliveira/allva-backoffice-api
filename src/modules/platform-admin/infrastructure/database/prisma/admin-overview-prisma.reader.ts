import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import type { OverviewMetricKey } from 'src/modules/platform-admin/domain/read-models';
import { AdminOverviewReaderInterface } from 'src/modules/platform-admin/domain/ports';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE_ORGANIZATION = { is: { deletedAt: null } } as const;

/**
 * Os números do Dashboard, uma consulta por métrica, isoladas como no hub:
 * uma que cai some da resposta e o resto chega.
 */
@Injectable()
export class AdminOverviewPrismaReader implements AdminOverviewReaderInterface {
  private readonly logger = new Logger(AdminOverviewPrismaReader.name);

  constructor(private readonly prisma: PrismaService) {}

  async compute(
    keys: readonly OverviewMetricKey[],
    now: Date,
  ): Promise<Partial<Record<OverviewMetricKey, number>>> {
    const settled = await Promise.allSettled(
      keys.map(async (key) => [key, await this.one(key, now)] as const),
    );

    const values: Partial<Record<OverviewMetricKey, number>> = {};

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        values[result.value[0]] = result.value[1];
        return;
      }
      this.logger.warn(
        `Overview metric "${keys[index]}" unavailable: ${String(
          (result.reason as Error)?.message ?? result.reason,
        )}`,
      );
    });

    return values;
  }

  private one(key: OverviewMetricKey, now: Date): Promise<number> {
    switch (key) {
      case 'orgs.total':
        return this.prisma.organization.count({ where: { deletedAt: null } });

      case 'orgs.active':
        return this.countSubscriptions(['ACTIVE']);

      case 'orgs.trialing':
        return this.countSubscriptions(['TRIALING']);

      case 'orgs.past_due':
        return this.countSubscriptions(['PAST_DUE', 'UNPAID']);

      case 'billing.monthly_recurring':
        return this.monthlyRecurring(now);

      /** Soma, em BRL, das faturas pendentes com vencimento no passado. */
      case 'billing.overdue_amount':
        return this.prisma.invoice
          .aggregate({
            where: { status: 'PENDING', dueAt: { lt: now }, currency: 'BRL' },
            _sum: { amount: true },
          })
          .then((result) => Number(result._sum.amount ?? 0));

      case 'support.tickets_open':
        return this.prisma.supportTicket.count({
          where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
        });

      case 'leads.new_30d':
        return this.prisma.salesLead.count({
          where: { createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) } },
        });

      case 'contacts.new_7d':
        return this.prisma.contact.count({
          where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
        });

      case 'integrations.connected':
        return this.prisma.integration.count({
          where: { status: 'CONNECTED', organization: LIVE_ORGANIZATION },
        });

      case 'integrations.unhealthy':
        return this.prisma.integration.count({
          where: {
            organization: LIVE_ORGANIZATION,
            OR: [
              { status: { in: ['TOKEN_EXPIRED', 'ERROR'] } },
              { status: 'CONNECTED', syncStatus: 'FAILED' },
            ],
          },
        });

      case 'operations.job_runs_failed_24h':
        return this.prisma.jobRun.count({
          where: {
            status: 'FAILED',
            startedAt: { gte: new Date(now.getTime() - DAY_MS) },
          },
        });
    }
  }

  private countSubscriptions(
    statuses: ('ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'UNPAID')[],
  ): Promise<number> {
    return this.prisma.organizationSubscription.count({
      where: { status: { in: statuses }, organization: LIVE_ORGANIZATION },
    });
  }

  /**
   * Recorrência mensal em BRL das assinaturas `ACTIVE`: o contrato que governa
   * (anual ÷ 12) ou o preço de tabela do plano. É o mesmo cálculo da coluna
   * "valor mensal" de Assinaturas — somar a coluna dá este número.
   * Contrato em outra moeda fica de fora em vez de ser somado como real.
   */
  private async monthlyRecurring(now: Date): Promise<number> {
    const rows = await this.prisma.organizationSubscription.findMany({
      where: { status: 'ACTIVE', organization: LIVE_ORGANIZATION },
      select: {
        plan: { select: { amount: true } },
        organization: {
          select: {
            contracts: {
              where: {
                status: {
                  in: ['SIGNED', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'],
                },
              },
              select: {
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
    });

    const total = rows.reduce((sum, row) => {
      const contract = selectGoverningContract(row.organization.contracts, now);
      if (!contract) return sum + (row.plan.amount ?? 0);
      if (contract.currency !== 'BRL') return sum;

      const amount = Number(contract.billingAmount);
      return (
        sum + (contract.billingInterval === 'ANNUAL' ? amount / 12 : amount)
      );
    }, 0);

    return Math.round(total * 100) / 100;
  }
}
