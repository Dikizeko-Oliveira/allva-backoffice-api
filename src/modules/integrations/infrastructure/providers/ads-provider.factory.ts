import { BadRequestException, Injectable } from '@nestjs/common';
import { AdsProviderGateway } from 'src/modules/integrations/domain/ports';
import {
  Platform,
  platformToProviderType,
} from 'src/modules/integrations/domain/entities/platform';
import type { ProviderType } from 'src/modules/integrations/domain/entities/integration.entity';
import { MetaAdsProvider } from './meta/meta-ads.provider';
import { GoogleAdsProvider } from './google/google-ads.provider';
import { TikTokAdsProvider } from './tiktok/tiktok-ads.provider';

@Injectable()
export class AdsProviderFactory {
  private readonly providers: Map<Platform, AdsProviderGateway>;

  constructor(
    metaProvider: MetaAdsProvider,
    googleProvider: GoogleAdsProvider,
    tiktokProvider: TikTokAdsProvider,
  ) {
    this.providers = new Map<Platform, AdsProviderGateway>([
      ['META', metaProvider],
      ['GOOGLE', googleProvider],
      ['TIKTOK', tiktokProvider],
    ]);
  }

  for(platform: Platform): AdsProviderGateway {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new BadRequestException({
        code: 'PLATFORM_NOT_AVAILABLE',
        message: `Platform ${platform} is not supported`,
      });
    }
    return provider;
  }

  forProviderType(providerType: ProviderType): AdsProviderGateway {
    const platform = providerType as Platform;
    return this.for(platform);
  }

  static providerTypeFromPlatform = platformToProviderType;
}
