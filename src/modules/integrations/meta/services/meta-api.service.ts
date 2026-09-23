import { Injectable } from '@nestjs/common';
import { MetaAdsProvider } from 'src/modules/integrations/infrastructure/providers/meta/meta-ads.provider';

/**
 * Backwards-compatible facade over MetaAdsProvider.
 * Existing call-sites (MetaController, ConnectMetaAccountUseCase) keep working.
 * New code should depend on AdsProviderGateway via AdsProviderFactory instead.
 */
@Injectable()
export class MetaApiService {
  constructor(private readonly provider: MetaAdsProvider) {}

  async createAuthorizationUrl(accountId: string): Promise<string> {
    return this.provider.getAuthorizationUrl({ accountId });
  }

  async exchangeAuthorizationCodeForLongLivedToken(
    code: string,
    state: string,
  ): Promise<{
    accessToken: string;
    expiresIn: number;
    accountId: string;
    organizationId: string | null;
  }> {
    const result = await this.provider.exchangeCodeForToken(code, state);
    const expiresIn = Math.max(
      0,
      Math.floor((result.token.expiresAt.getTime() - Date.now()) / 1000),
    );
    return {
      accessToken: result.token.accessToken,
      expiresIn,
      accountId: result.accountId,
      organizationId: result.organizationId,
    };
  }
}
