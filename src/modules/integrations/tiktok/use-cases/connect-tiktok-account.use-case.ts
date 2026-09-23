import { Injectable } from '@nestjs/common';
import {
  CreateIntegrationInputDto,
  CreateIntegrationOutputDto,
  ProviderTypeDto,
} from 'src/modules/integrations/application/dtos';
import { CreateIntegrationUseCase } from 'src/modules/integrations/application/use-cases';
import { TikTokAdsProvider } from 'src/modules/integrations/infrastructure/providers/tiktok/tiktok-ads.provider';

@Injectable()
export class ConnectTikTokAccountUseCase {
  constructor(
    private readonly tikTokAdsProvider: TikTokAdsProvider,
    private readonly createIntegrationUseCase: CreateIntegrationUseCase,
  ) {}

  async execute(
    code: string,
    state: string,
  ): Promise<CreateIntegrationOutputDto> {
    const { token, accountId, organizationId } =
      await this.tikTokAdsProvider.exchangeCodeForToken(code, state);

    return this.createIntegrationUseCase.execute(
      {
        provider: 'tiktok',
        providerType: ProviderTypeDto.TIKTOK,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt.toISOString(),
        name: 'TikTok Ads',
      } as CreateIntegrationInputDto,
      accountId,
      organizationId,
    );
  }
}
