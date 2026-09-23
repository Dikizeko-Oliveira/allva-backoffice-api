import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PlatformCredential,
  PlatformCredentialProvider,
  RefreshedTokens,
} from 'src/modules/platform-clients/domain/ports/platform-credential.provider';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { TokenCipherService } from 'src/shared/infrastructure/security/token-cipher.service';

/**
 * `integrations` implementando o contrato que `platform-clients` declara (D1).
 *
 * A dependência aponta na direção certa: o transporte diz o que precisa, e quem
 * guarda a credencial obedece. O caminho oposto — `platform-clients` importando
 * `integrations` — fecharia o ciclo que impede o token bucket de R4 de existir.
 *
 * O token sai daqui **decifrado** e volta por `onRefreshed` para ser cifrado de
 * novo com o `TokenCipherService` que já existe: o transporte nunca vê a chave,
 * e a persistência nunca vê a política de refresh.
 */
@Injectable()
export class PrismaPlatformCredentialProvider extends PlatformCredentialProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
  ) {
    super();
  }

  async resolve(adAccountId: string): Promise<PlatformCredential> {
    const adAccount = await this.prisma.adAccount.findUnique({
      where: { id: adAccountId },
      select: { integrationId: true, platform: true, organizationId: true },
    });

    if (!adAccount?.integrationId) {
      // Conta sem credencial corrente é estado legítimo depois de um disconnect
      // (P10: a identidade sobrevive à credencial). Quem chama leva a conta a
      // `UNREACHABLE`; o que não pode é seguir com um token vazio.
      throw new NotFoundException({
        code: 'AD_ACCOUNT_WITHOUT_CREDENTIAL',
        message: `A conta ${adAccountId} não tem integração conectada.`,
      });
    }

    return this.resolveByIntegration(adAccount.integrationId);
  }

  async resolveByIntegration(
    integrationId: string,
  ): Promise<PlatformCredential> {
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        organizationId: true,
        providerType: true,
        accessToken: true,
        expiresAt: true,
      },
    });

    if (!integration) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_FOUND',
        message: `Integração ${integrationId} não encontrada.`,
      });
    }

    return {
      integrationId: integration.id,
      organizationId: integration.organizationId,
      platform: integration.providerType as Platform,
      accessToken: this.cipher.decrypt(integration.accessToken),
      expiresAt: integration.expiresAt,
    };
  }

  async onRefreshed(
    integrationId: string,
    tokens: RefreshedTokens,
  ): Promise<void> {
    await this.prisma.integration.update({
      where: { id: integrationId },
      data: {
        accessToken: this.cipher.encrypt(tokens.accessToken),
        ...(tokens.refreshToken
          ? { refreshToken: this.cipher.encrypt(tokens.refreshToken) }
          : {}),
        expiresAt: tokens.expiresAt,
      },
    });
  }
}
