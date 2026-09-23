import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Integration } from 'src/modules/integrations/domain/entities';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { Platform } from 'src/modules/integrations/domain/entities/platform';

/** Vocabulário que as três plataformas usam para "esta credencial não vale mais". */
const AUTHORIZATION_MARKERS = [
  'invalid_grant',
  'invalid_token',
  'oauthexception',
  'token has expired',
  'token expired',
  'session has been invalidated',
  'access token',
  'unauthorized',
];

/**
 * Distingue "a credencial morreu" de "a plataforma tropeçou".
 *
 * Status 401/403 é a evidência forte; a varredura de mensagem cobre os
 * provedores que embrulham a recusa num 502 do lado deles — Meta devolve
 * `OAuthException` dentro de `META_TOKEN_EXCHANGE_FAILED`, e sem olhar a
 * mensagem toda recusa de autorização dela pareceria transitória.
 */
function isAuthorizationFailure(error: unknown): boolean {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 401 || status === 403) return true;
  }

  const message = (error as Error)?.message?.toLowerCase() ?? '';
  return AUTHORIZATION_MARKERS.some((marker) => message.includes(marker));
}

@Injectable()
export class RefreshIntegrationTokenUseCase {
  private readonly logger = new Logger(RefreshIntegrationTokenUseCase.name);

  constructor(
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
  ) {}

  async executeForIntegration(integration: Integration): Promise<Integration> {
    const provider = this.providers.for(integration.providerType as Platform);

    try {
      const token = await provider.refreshAccessToken(integration);
      integration.updateTokens({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
      });
      await this.integrationsRepository.update(integration);
      return integration;
    } catch (error) {
      const message = (error as Error).message ?? 'unknown';
      this.logger.warn(
        `Token refresh failed for integration ${integration.id} (${integration.providerType}): ${message}`,
      );

      /**
       * Nem toda falha de refresh é credencial vencida.
       *
       * Um timeout ou um 502 da plataforma é transitório, e marcá-lo como
       * `TOKEN_EXPIRED` mandaria o usuário reconectar uma conta que está
       * perfeitamente conectada. Só a recusa de autorização vira o estado que
       * pede ação dele; o resto é erro, e o ciclo seguinte tenta de novo.
       */
      if (isAuthorizationFailure(error)) {
        integration.markTokenExpired(`Token refresh failed: ${message}`);
      } else {
        integration.markError(`Token refresh failed: ${message}`);
      }

      await this.integrationsRepository.update(integration);
      throw error;
    }
  }
}
