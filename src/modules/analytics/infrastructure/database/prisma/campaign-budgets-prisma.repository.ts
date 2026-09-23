import { Injectable } from '@nestjs/common';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  CampaignBudgetsRepositoryInterface,
  type CampaignBudgetRow,
} from 'src/modules/analytics/domain/ports/campaign-budgets.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type Row = {
  id: string;
  name: string;
  platform: Platform;
  currency: string;
  dailyBudget: unknown;
  lifetimeBudget: unknown;
  adSets: Array<{ dailyBudget: unknown }>;
};

/** `Decimal` do Prisma não é `number` — converter aqui evita `NaN` silencioso. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class CampaignBudgetsPrismaRepository implements CampaignBudgetsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveWithBudgets(query: {
    organizationId: string;
    platforms?: Platform[];
  }): Promise<CampaignBudgetRow[]> {
    const records = await this.prisma.campaign.findMany({
      where: {
        organizationId: query.organizationId,
        archivedAt: null,
        ...(query.platforms?.length
          ? { platform: { in: query.platforms as never } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        platform: true,
        currency: true,
        dailyBudget: true,
        lifetimeBudget: true,
        // Só conjuntos vivos: o orçamento de um conjunto arquivado não é teto
        // de nada, e somá-lo inflaria o denominador do ritmo.
        adSets: {
          where: { archivedAt: null },
          select: { dailyBudget: true },
        },
      },
    });

    return (records as unknown as Row[]).map((row) => ({
      campaignId: row.id,
      campaignName: row.name,
      platform: row.platform,
      currency: row.currency,
      dailyBudget: toNumber(row.dailyBudget),
      lifetimeBudget: toNumber(row.lifetimeBudget),
      adSetDailyBudgets: row.adSets.map((adSet) => toNumber(adSet.dailyBudget)),
    }));
  }

  async organizationBaseCurrency(
    organizationId: string,
  ): Promise<string | null> {
    const row = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { baseCurrency: true },
    });

    return row?.baseCurrency ?? null;
  }
}
