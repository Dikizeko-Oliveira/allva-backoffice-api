import { Injectable } from '@nestjs/common';
import type {
  AccessStatus,
  BillingStatus,
} from 'src/modules/subscriptions/access/domain/access-status';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import type { AccountAccessFacts } from 'src/modules/subscriptions/access/domain/organization-access';
import {
  OrganizationSweepRepositoryInterface,
  OrganizationSweepSnapshot,
} from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { LIVE_CONTRACTS_QUERY, contractTermOf } from './live-contracts.query';

const ACCOUNT_SUBSCRIPTION_SELECT = {
  billingStatus: true,
  accessStatus: true,
  gracePeriodEndsAt: true,
  expiresAt: true,
  plan: { select: { type: true } },
} as const;

type AccountSubscriptionRow = {
  billingStatus: string;
  accessStatus: string | null;
  gracePeriodEndsAt: Date | null;
  expiresAt: Date | null;
  plan: { type: string } | null;
};

@Injectable()
export class OrganizationSweepPrismaRepository extends OrganizationSweepRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Uma consulta por lote, e não o resolver chamado organização a organização:
   * o tick horário do ingest passa por toda organização com conta sincronizável.
   */
  async findSnapshots(
    organizationIds: readonly string[],
    now: Date,
  ): Promise<OrganizationSweepSnapshot[]> {
    if (organizationIds.length === 0) return [];

    const rows = await this.prisma.organization.findMany({
      where: { id: { in: [...organizationIds] } },
      select: {
        id: true,
        deletedAt: true,
        accessClosedAt: true,
        subscription: { select: { status: true, trialEndsAt: true } },
        contracts: LIVE_CONTRACTS_QUERY,
        owner: {
          select: { subscription: { select: ACCOUNT_SUBSCRIPTION_SELECT } },
        },
        // Os mesmos membros que `findEffectiveForAccount` aceita.
        users: {
          where: { status: 'ACTIVE', deletedAt: null },
          select: {
            user: {
              select: {
                subscription: { select: ACCOUNT_SUBSCRIPTION_SELECT },
              },
            },
          },
        },
      },
    });

    return rows.map((row) => {
      const contract = selectGoverningContract(row.contracts, now);
      // Quem não tem assinatura pessoal não abre nada por esse caminho.
      const accounts = [
        row.owner.subscription,
        ...row.users.map((member) => member.user.subscription),
      ].flatMap((subscription) =>
        subscription ? [toAccountFacts(subscription)] : [],
      );

      return {
        organizationId: row.id,
        deletedAt: row.deletedAt,
        accessClosedAt: row.accessClosedAt,
        subscription: row.subscription
          ? {
              status: row.subscription.status as BillingStatus,
              trialEndsAt: row.subscription.trialEndsAt ?? null,
              contract: contract ? contractTermOf(contract) : null,
            }
          : null,
        accounts,
      };
    });
  }

  async markAccessClosed(
    organizationIds: readonly string[],
    at: Date,
  ): Promise<void> {
    if (organizationIds.length === 0) return;

    await this.prisma.organization.updateMany({
      where: { id: { in: [...organizationIds] }, accessClosedAt: null },
      data: { accessClosedAt: at },
    });
  }

  async clearAccessClosed(organizationIds: readonly string[]): Promise<void> {
    if (organizationIds.length === 0) return;

    await this.prisma.organization.updateMany({
      where: {
        id: { in: [...organizationIds] },
        accessClosedAt: { not: null },
      },
      data: { accessClosedAt: null },
    });
  }
}

function toAccountFacts(row: AccountSubscriptionRow): AccountAccessFacts {
  return {
    billingStatus: row.billingStatus as BillingStatus,
    accessStatus: (row.accessStatus as AccessStatus | null) ?? null,
    gracePeriodEndsAt: row.gracePeriodEndsAt,
    planType: row.plan?.type ?? null,
    expiresAt: row.expiresAt,
  };
}
