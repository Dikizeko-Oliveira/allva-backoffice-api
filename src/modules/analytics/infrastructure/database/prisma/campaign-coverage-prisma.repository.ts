import { Injectable } from '@nestjs/common';
import type { CampaignCoverageRow } from 'src/modules/analytics/domain/campaign-coverage';
import { CampaignCoverageRepositoryInterface } from 'src/modules/analytics/domain/ports/campaign-coverage.repository';
import { sweepableAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class CampaignCoveragePrismaRepository extends CampaignCoverageRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listWithoutAnalyzableAds(input: {
    organizationId: string;
    now: Date;
  }): Promise<CampaignCoverageRow[]> {
    const rows = await this.prisma.campaign.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: null,
        // Conta desconectada ou congelada não é lacuna de cobertura: é conta
        // que o sync não lê, e a tela de integrações já diz isso.
        adAccount: { is: sweepableAdAccountWhere(input.now) },
        ads: { none: { archivedAt: null } },
      },
      select: {
        id: true,
        name: true,
        platform: true,
        status: true,
        objective: true,
        adAccount: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      campaignId: row.id,
      campaignName: row.name,
      platform: row.platform,
      rawStatus: row.status,
      objective: row.objective,
      adAccountName: row.adAccount.name,
    }));
  }
}
