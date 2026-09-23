import { Injectable } from '@nestjs/common';
import { DEFAULT_DETECTOR_PROFILE_VERSION } from 'src/modules/waste/domain/detector-profile';
import {
  WasteSettingsReader,
  type WasteReadSettings,
} from 'src/modules/waste/domain/ports/waste-settings.reader';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class WasteSettingsPrismaReader extends WasteSettingsReader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async forOrganization(organizationId: string): Promise<WasteReadSettings> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        baseCurrency: true,
        currencyState: true,
        adsSettings: {
          select: {
            scoringWindowDays: true,
            activeDetectorProfileVersion: true,
          },
        },
      },
    });

    return {
      organizationId,
      // Os defaults são os do schema, não valores inventados aqui: a linha de
      // `organization_ads_settings` existe para toda organização desde a
      // correção de dívida que precedeu A2-S4, e este ramo é a última rede.
      windowDays: organization?.adsSettings?.scoringWindowDays ?? 14,
      detectorProfileVersion:
        organization?.adsSettings?.activeDetectorProfileVersion ??
        DEFAULT_DETECTOR_PROFILE_VERSION,
      baseCurrency: organization?.baseCurrency ?? 'BRL',
      recomputingCurrency:
        organization?.currencyState === 'RECOMPUTING_CURRENCY',
    };
  }
}
