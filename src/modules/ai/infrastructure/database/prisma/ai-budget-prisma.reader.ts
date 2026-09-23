import { Injectable } from '@nestjs/common';
import {
  AiBudgetReader,
  type AiBudgetSettings,
} from 'src/modules/ai/domain/ports/ai-budget.reader';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { estimatedCallCostBase } from 'src/modules/ai/domain/model-pricing';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

@Injectable()
export class AiBudgetPrismaReader extends AiBudgetReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {
    super();
  }

  async budgetFor(organizationId: string): Promise<AiBudgetSettings> {
    const [settings, organization] = await Promise.all([
      this.prisma.organizationAdsSettings.findUnique({
        where: { organizationId },
        select: { llmDailyBudgetBase: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { baseCurrency: true },
      }),
    ]);

    const pricing = {
      baseCurrency: organization?.baseCurrency ?? 'BRL',
      pricingBaseCurrency: this.env.get('AI_PRICING_BASE_CURRENCY'),
      usdToBase: this.env.get('AI_USD_TO_BASE_RATE'),
    };

    return {
      llmDailyBudgetBase:
        settings?.llmDailyBudgetBase === null ||
        settings?.llmDailyBudgetBase === undefined
          ? null
          : Number(settings.llmDailyBudgetBase),
      estimatedCallCostBase: estimatedCallCostBase(pricing),
      pricing,
    };
  }
}
