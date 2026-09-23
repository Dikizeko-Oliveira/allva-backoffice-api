import { Injectable } from '@nestjs/common';
import { Subscription } from 'src/modules/subscriptions/domain/entities/subscription.entity';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports/subscriptions.repository';
import { Plan, PlanFeature } from 'src/modules/plans/domain/entities';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  AccessStatus,
  BillingStatus,
} from 'src/modules/subscriptions/access/domain/access-status';

type SubscriptionWithPlan = {
  id: string;
  accountId: string;
  planId: string;
  billingCardId: string | null;
  billingStatus: string;
  accessStatus: string;
  startedAt: Date;
  expiresAt: Date;
  gracePeriodEndsAt: Date | null;
  automaticRenovation: boolean;
  isAnnual: boolean;
  externalSubscriptionId: string | null;
  externalReference: string | null;
  authorizationUrl: string | null;
  nextBillingAt: Date | null;
  canceledAt: Date | null;
  pendingPlanId: string | null;
  pendingPlanEffectiveAt: Date | null;
  billingProvider: string | null;
  createdAt: Date;
  plan: {
    id: string;
    type: string;
    amount: number | null;
    amountAnnual: number | null;
    name: string;
    trialDays: number | null;
    stripePriceId: string | null;
    stripePriceIdAnnual: string | null;
    createdAt: Date;
    features: Array<{
      id: string;
      key: string;
      name: string;
      enabled: boolean;
      value: string | null;
      description: string | null;
      sortOrder: number;
      landingHighlight: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>;
  } | null;
};

@Injectable()
export class SubscriptionsPrismaRepository implements SubscriptionsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Subscription | null> {
    const record = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
    });

    return record ? this.toDomain(record as SubscriptionWithPlan) : null;
  }

  async findByAccountId(accountId: string): Promise<Subscription | null> {
    const record = await this.prisma.subscription.findUnique({
      where: { accountId },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
    });

    return record ? this.toDomain(record as SubscriptionWithPlan) : null;
  }

  async findByExternalSubscriptionId(
    externalSubscriptionId: string,
  ): Promise<Subscription | null> {
    const record = await this.prisma.subscription.findUnique({
      where: { externalSubscriptionId },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
    });

    return record ? this.toDomain(record as SubscriptionWithPlan) : null;
  }

  async findByExternalReference(
    externalReference: string,
  ): Promise<Subscription | null> {
    const record = await this.prisma.subscription.findUnique({
      where: { externalReference },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
    });

    return record ? this.toDomain(record as SubscriptionWithPlan) : null;
  }

  async listForReconciliation(
    statuses: BillingStatus[],
    limit = 100,
  ): Promise<Subscription[]> {
    const records = await this.prisma.subscription.findMany({
      where: {
        billingStatus: { in: statuses as any },
        externalSubscriptionId: { not: null },
      },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    return records.map((record) =>
      this.toDomain(record as SubscriptionWithPlan),
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.subscription.delete({ where: { id } });
  }

  async save(subscription: Subscription): Promise<void> {
    await this.prisma.subscription.create({
      data: {
        id: subscription.id,
        accountId: subscription.accountId,
        planId: subscription.planId,
        billingCardId: subscription.billingCardId,
        billingProvider: subscription.billingProvider,
        externalSubscriptionId: subscription.externalSubscriptionId,
        externalReference: subscription.externalReference,
        authorizationUrl: subscription.authorizationUrl,
        nextBillingAt: subscription.nextBillingAt,
        canceledAt: subscription.canceledAt,
        pendingPlanId: subscription.pendingPlanId ?? null,
        pendingPlanEffectiveAt: subscription.pendingPlanEffectiveAt ?? null,
        gracePeriodEndsAt: subscription.gracePeriodEndsAt,
        billingStatus: subscription.billingStatus,
        accessStatus: subscription.accessStatus,
        startedAt: subscription.startedAt,
        expiresAt: subscription.expiresAt,
        createdAt: subscription.createdAt,
      },
    });
  }

  async update(subscription: Subscription): Promise<void> {
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: subscription.planId,
        billingCardId: subscription.billingCardId,
        billingProvider: subscription.billingProvider,
        externalSubscriptionId: subscription.externalSubscriptionId,
        externalReference: subscription.externalReference,
        authorizationUrl: subscription.authorizationUrl,
        nextBillingAt: subscription.nextBillingAt,
        canceledAt: subscription.canceledAt,
        pendingPlanId: subscription.pendingPlanId ?? null,
        pendingPlanEffectiveAt: subscription.pendingPlanEffectiveAt ?? null,
        gracePeriodEndsAt: subscription.gracePeriodEndsAt,
        billingStatus: subscription.billingStatus,
        accessStatus: subscription.accessStatus,
        automaticRenovation: subscription.automaticRenovation,
        isAnnual: subscription.isAnnual,
        startedAt: subscription.startedAt,
        expiresAt: subscription.expiresAt,
      },
    });
  }

  private toDomain(record: SubscriptionWithPlan): Subscription {
    const plan = record.plan ? this.toDomainPlan(record.plan) : undefined;

    return Subscription.restore({
      id: record.id,
      accountId: record.accountId,
      planId: record.planId,
      billingCardId: record.billingCardId ?? undefined,
      billingProvider:
        (record.billingProvider as 'STRIPE' | undefined) ?? undefined,
      externalSubscriptionId: record.externalSubscriptionId ?? undefined,
      externalReference: record.externalReference ?? undefined,
      authorizationUrl: record.authorizationUrl ?? undefined,
      nextBillingAt: record.nextBillingAt ?? undefined,
      canceledAt: record.canceledAt ?? undefined,
      pendingPlanId: record.pendingPlanId ?? undefined,
      pendingPlanEffectiveAt: record.pendingPlanEffectiveAt ?? undefined,
      gracePeriodEndsAt: record.gracePeriodEndsAt ?? undefined,
      billingStatus: record.billingStatus as BillingStatus,
      accessStatus: record.accessStatus as AccessStatus,
      automaticRenovation: record.automaticRenovation,
      isAnnual: record.isAnnual,
      startedAt: record.startedAt,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      plan,
    });
  }

  private toDomainPlan(record: SubscriptionWithPlan['plan']): Plan {
    if (!record) {
      throw new Error('Plan record is required to map subscription');
    }

    return Plan.restore({
      id: record.id,
      type: record.type as 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE',
      amount: record.amount ?? 0,
      amountAnnual: record.amountAnnual,
      name: record.name,
      trialDays: record.trialDays,
      stripePriceId: record.stripePriceId,
      stripePriceIdAnnual: record.stripePriceIdAnnual,
      createdAt: record.createdAt,
      features: record.features.map((feature) =>
        PlanFeature.restore({
          id: feature.id,
          key: feature.key,
          name: feature.name,
          enabled: feature.enabled,
          value: feature.value,
          description: feature.description,
          sortOrder: feature.sortOrder,
          landingHighlight: feature.landingHighlight,
          createdAt: feature.createdAt,
          updatedAt: feature.updatedAt,
        }),
      ),
    });
  }
}
