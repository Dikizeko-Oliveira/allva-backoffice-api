import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BillingStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import {
  ExpiredTrialRef,
  OrganizationEntitlementRepositoryInterface,
  OrganizationEntitlementView,
} from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';
import { LIVE_CONTRACTS_QUERY, contractTermOf } from './live-contracts.query';

@Injectable()
export class OrganizationEntitlementPrismaRepository implements OrganizationEntitlementRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findEffectiveForAccount(
    accountId: string,
    organizationId?: string | null,
  ): Promise<OrganizationEntitlementView | null> {
    // The account must own the org or hold an ACTIVE membership in it.
    // Membership is re-checked here (not just trusted from the request) so the
    // resolver stays safe even when called outside the org-context middleware.
    const accessibleOrganization = {
      deletedAt: null,
      OR: [
        { ownerId: accountId },
        {
          users: {
            some: {
              accountId,
              status: 'ACTIVE' as const,
              deletedAt: null,
            },
          },
        },
      ],
    };

    const subscription = await this.prisma.organizationSubscription.findFirst({
      where: organizationId
        ? { organizationId, organization: accessibleOrganization }
        : { organization: accessibleOrganization },
      include: {
        plan: true,
        /**
         * Os contratos vivos da organização, pela **mesma consulta** que a
         * varredura dos jobs usa. O porquê de cada filtro está em
         * `LIVE_CONTRACTS_QUERY`.
         */
        organization: { include: { contracts: LIVE_CONTRACTS_QUERY } },
      },
      // Deterministic default when the account belongs to several orgs: the
      // earliest. X-Organization-Id (passed as organizationId) overrides this.
      orderBy: { createdAt: 'asc' },
    });

    if (!subscription) return null;

    const contract = selectGoverningContract(
      subscription.organization?.contracts ?? [],
    );

    return {
      organizationSubscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      planId: subscription.planId,
      planName: subscription.plan?.name ?? null,
      planType: subscription.plan?.type ?? null,
      status: subscription.status as BillingStatus,
      trialEndsAt: subscription.trialEndsAt ?? null,
      contract: contract
        ? {
            ...contractTermOf(contract),
            id: contract.id,
            contractNumber: contract.contractNumber,
            billingInterval: contract.billingInterval,
            paymentTerms: contract.paymentTerms,
            paymentMethod: contract.paymentMethod,
            autoRenew: contract.autoRenew,
          }
        : null,
    };
  }

  async listExpiredTrials(
    now: Date,
    limit: number,
  ): Promise<ExpiredTrialRef[]> {
    const rows = await this.prisma.organizationSubscription.findMany({
      // A null trialEndsAt never matches `lte`, so open-ended trials are safe.
      where: { status: 'TRIALING', trialEndsAt: { lte: now } },
      select: { id: true, organizationId: true },
      take: limit,
      orderBy: { trialEndsAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
    }));
  }

  async markExpired(organizationSubscriptionId: string): Promise<void> {
    await this.prisma.organizationSubscription.update({
      where: { id: organizationSubscriptionId },
      data: { status: 'EXPIRED' },
    });
  }
}
