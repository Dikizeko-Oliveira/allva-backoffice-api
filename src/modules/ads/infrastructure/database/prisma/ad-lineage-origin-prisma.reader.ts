import { Injectable } from '@nestjs/common';
import {
  AdLineageOrigin,
  AdLineageOriginReader,
} from 'src/modules/ads/domain/ports/ad-lineage-origin.reader';
import { producesSuccessor } from 'src/modules/ads/domain/ad-lineage';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AdLineageOriginPrismaReader extends AdLineageOriginReader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findOriginFor(input: {
    organizationId: string;
    adAccountId: string;
    externalAdIds: string[];
  }): Promise<Map<string, AdLineageOrigin>> {
    if (input.externalAdIds.length === 0) return new Map();

    const rows = await this.prisma.actionExecution.findMany({
      where: {
        organizationId: input.organizationId,
        resultPlatformEntityId: { in: input.externalAdIds },
        /**
         * `PARTIALLY_COMPLETED` também: a recriação que criou o anúncio novo e
         * não terminou os passos seguintes **criou** o sucessor. Ignorá-la faria
         * o ingest descobrir um anúncio sem origem, e a linhagem se partiria
         * exatamente no caso que mais precisa de rastro.
         */
        status: { in: ['SUCCEEDED', 'PARTIALLY_COMPLETED'] },
        dryRun: false,
        action: { ad: { adAccountId: input.adAccountId } },
      },
      /**
       * A mais recente vence. Uma cadeia de recriações sobre o mesmo anúncio
       * produz várias execuções, e é a última que descreve de quem este id
       * nasceu — as anteriores descrevem gerações que já foram sucedidas.
       */
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        resultPlatformEntityId: true,
        action: {
          select: {
            type: true,
            adId: true,
            ad: { select: { lineageId: true, platform: true } },
          },
        },
      },
    });

    const origins = new Map<string, AdLineageOrigin>();

    for (const row of rows) {
      const externalId = row.resultPlatformEntityId;
      if (!externalId || origins.has(externalId)) continue;

      /**
       * **Só sucessão herda.** `DUPLICATE_AD` também devolve id novo, e o
       * original continua veiculando: herdar ali fundiria dois anúncios que
       * competem entre si numa série só.
       */
      if (!producesSuccessor(row.action.ad.platform, row.action.type)) continue;

      origins.set(externalId, {
        originAdId: row.action.adId,
        lineageId: row.action.ad.lineageId,
        executionId: row.id,
      });
    }

    return origins;
  }
}
