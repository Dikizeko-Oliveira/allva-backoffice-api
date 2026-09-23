import { Injectable } from '@nestjs/common';
import { Plan, PlanFeature } from 'src/modules/plans/domain/entities';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports/plans.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class PlansPrismaRepository implements PlansRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findByType(
    type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE',
  ): Promise<Plan | null> {
    const record = await this.prisma.plan.findUnique({
      where: { type },
      include: { features: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async findById(id: string): Promise<Plan | null> {
    const record = await this.prisma.plan.findUnique({
      where: { id },
      include: { features: { orderBy: { sortOrder: 'asc' } } },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async listAll(): Promise<Plan[]> {
    const records = await this.prisma.plan.findMany({
      include: { features: { orderBy: { sortOrder: 'asc' } } },
    });

    return records.map((record) => this.toDomain(record));
  }

  async save(plan: Plan): Promise<void> {
    await this.prisma.plan.create({
      data: {
        id: plan.id,
        name: plan.name,
        amount: plan.amount,
        amountAnnual: plan.amountAnnual ?? undefined,
        trialDays: plan.trialDays,
        type: plan.type as any,
        stripePriceId: plan.stripePriceId ?? undefined,
        stripePriceIdAnnual: plan.stripePriceIdAnnual ?? undefined,
        createdAt: plan.createdAt,
        features: {
          create: plan.features.map((feature) => ({
            id: feature.id,
            key: feature.key,
            name: feature.name,
            enabled: feature.enabled,
            value: feature.value,
            ...(feature.description !== null
              ? { description: feature.description }
              : {}),
            sortOrder: feature.sortOrder,
            landingHighlight: feature.landingHighlight,
            createdAt: feature.createdAt,
            updatedAt: feature.updatedAt,
          })),
        },
      },
    });
  }

  private toDomain(record: {
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
  }): Plan {
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
