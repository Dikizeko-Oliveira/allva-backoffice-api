import type { Platform } from 'src/modules/integrations/domain/entities/platform';

export type PlatformCredential = {
  integrationId: string;
  organizationId: string;
  platform: Platform;
  accessToken: string;
  /** Quando expira; `platform-clients` decide renovar antes de gastar a chamada. */
  expiresAt: Date | null;
};

export type RefreshedTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
};

/**
 * A inversão que resolve o ciclo `integrations` ↔ `platform-clients` (D1).
 *
 * O transporte precisa de credencial e de refresh de token; as credenciais
 * pertencem a `integrations`, que por sua vez depende do transporte. Sem esta
 * inversão o módulo nasceria com dependência circular — e o token bucket único
 * de R4, que é a razão de `platform-clients` existir, voltaria a ser impossível.
 *
 * O contrato é declarado **aqui**, no transporte, e implementado em
 * `integrations`: quem tem a credencial obedece a quem precisa dela. O refresh
 * acontece dentro de `platform-clients` — é transporte — e os tokens voltam por
 * `onRefreshed`, que `integrations` persiste cifrado com o `TokenCipherService`
 * que já existe.
 */
export abstract class PlatformCredentialProvider {
  abstract resolve(adAccountId: string): Promise<PlatformCredential>;

  abstract resolveByIntegration(
    integrationId: string,
  ): Promise<PlatformCredential>;

  abstract onRefreshed(
    integrationId: string,
    tokens: RefreshedTokens,
  ): Promise<void>;
}
