import { Injectable } from '@nestjs/common';
import {
  CreateIntegrationInputDto,
  CreateIntegrationOutputDto,
  ProviderTypeDto,
} from 'src/modules/integrations/application/dtos';
import { CreateIntegrationUseCase } from 'src/modules/integrations/application/use-cases';
import { GoogleAdsProvider } from 'src/modules/integrations/infrastructure/providers/google/google-ads.provider';

@Injectable()
export class ConnectGoogleAccountUseCase {
  constructor(
    private readonly googleAdsProvider: GoogleAdsProvider,
    private readonly createIntegrationUseCase: CreateIntegrationUseCase,
  ) {}

  async execute(
    code: string,
    state: string,
  ): Promise<CreateIntegrationOutputDto> {
    const { token, accountId, organizationId } =
      await this.googleAdsProvider.exchangeCodeForToken(code, state);

    return this.createIntegrationUseCase.execute(
      {
        provider: 'google',
        providerType: ProviderTypeDto.GOOGLE,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt.toISOString(),
        name: 'Google Ads',
      } as CreateIntegrationInputDto,
      accountId,
      organizationId,
    );
  }
}
