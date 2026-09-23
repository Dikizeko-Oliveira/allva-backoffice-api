import { AdAccount } from '../entities';
import type { Platform } from '../entities/platform';

/**
 * A saúde de sincronização de uma conta (D17), **como leitura**.
 *
 * Não entra na entidade `AdAccount` de propósito: quem escreve estes campos é o
 * módulo `sync` — `UNREACHABLE` é o veredito do passo 9 de §8.2, quando o
 * ingest não conseguiu ver a conta inteira. `integrations` só os lê para dizer
 * ao usuário por que o número dele está velho. Pô-los na entidade sugeriria que
 * este módulo os mantém, e o próximo a mexer aqui tentaria escrevê-los.
 */
export type AdAccountSyncHealthView = {
  adAccountId: string;
  syncHealth: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';
  syncHealthReason: string | null;
  unreachableSince: Date | null;
  lastSuccessfulFullSyncAt: Date | null;
};

export abstract class AdAccountsRepositoryInterface {
  abstract save(adAccount: AdAccount): Promise<void>;
  abstract update(adAccount: AdAccount): Promise<void>;
  abstract findById(id: string): Promise<AdAccount | null>;
  abstract findByIntegrationAndExternalId(
    integrationId: string,
    externalAccountId: string,
  ): Promise<AdAccount | null>;

  /**
   * Busca pela **mesma chave da constraint** `(organizationId, platform,
   * externalAccountId)`.
   *
   * Existe porque `findByIntegrationAndExternalId` não serve como guarda de
   * duplicata: a credencial é atributo corrente da conta, não parte da
   * identidade dela (P10), e desconectar zera o `integrationId`. Uma busca por
   * credencial não encontrava a linha órfã, o `create` esbarrava na unique, e o
   * P2002 subia como 500 — no fluxo mais comum que existe, desconectar e
   * reconectar.
   */
  abstract findByOrganizationPlatformAndExternalId(
    organizationId: string,
    platform: Platform,
    externalAccountId: string,
  ): Promise<AdAccount | null>;

  abstract listByIntegrationId(integrationId: string): Promise<AdAccount[]>;

  /**
   * Contas **ativas** da organização — o uso contra o qual o teto do plano
   * incide.
   *
   * Só ativas: uma conta desvinculada é soft-delete (`isActive = false`) e
   * continua na tabela. Contá-la faria o cliente que desconectou uma conta e
   * ligou outra bater no teto sem ter aumentado nada.
   */
  abstract countActiveByOrganizationId(organizationId: string): Promise<number>;
  abstract listActiveByIntegrationId(
    integrationId: string,
  ): Promise<AdAccount[]>;
  abstract markIntegrationAccountsDisconnected(
    integrationId: string,
  ): Promise<void>;

  /** A saúde de §8.2/D17 das contas de uma integração, indexada por `adAccountId`. */
  abstract listSyncHealthByIntegrationId(
    integrationId: string,
  ): Promise<AdAccountSyncHealthView[]>;
}
