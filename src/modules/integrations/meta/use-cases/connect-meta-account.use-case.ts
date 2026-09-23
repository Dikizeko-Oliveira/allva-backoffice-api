import { Injectable } from '@nestjs/common';
import { CreateIntegrationOutputDto } from 'src/modules/integrations/application/dtos';
import { CreateIntegrationUseCase } from 'src/modules/integrations/application/use-cases';
import { MetaApiService } from 'src/modules/integrations/meta/services/meta-api.service';

type ConnectMetaAccountInput = {
  userId: string;
  authorizationCode: string;
  state: string;
};

@Injectable()
export class ConnectMetaAccountUseCase {
  constructor(
    private readonly metaApiService: MetaApiService,
    private readonly createIntegrationUseCase: CreateIntegrationUseCase,
  ) {}

  async execute(
    input: ConnectMetaAccountInput,
  ): Promise<CreateIntegrationOutputDto> {
    return this.executeWithCallback(input.authorizationCode, input.state);
  }

  async executeWithCallback(
    code: string,
    state: string,
  ): Promise<CreateIntegrationOutputDto> {
    const token =
      await this.metaApiService.exchangeAuthorizationCodeForLongLivedToken(
        code,
        state,
      );

    const expiresAt = new Date(Date.now() + token.expiresIn * 1000);

    return this.createIntegrationUseCase.execute(
      {
        name: 'Meta Ads',
        provider: 'meta',
        providerType: 'META' as never,
        accessToken: token.accessToken,
        expiresAt: expiresAt.toISOString(),
      },
      token.accountId,
      token.organizationId,
    );
  }
}
