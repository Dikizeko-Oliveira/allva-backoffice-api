import type { IntegrationStatus } from 'src/modules/integrations/domain/entities/integration.entity';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdAccountSyncHealth, SyncHealthReason } from '../account-health';

/**
 * A `AdAccount` da v2.0, do ponto de vista do sync.
 *
 * `integrations` continua dono da conexão, do OAuth e da credencial; o `sync`
 * é dono do **estado de observação** da conta — saúde, carimbos de última
 * leitura e janela de re-declaração. É a fronteira do deliverable 1 de A2-S3.
 */

export type SyncableAdAccount = {
  id: string;
  accountId: string;
  organizationId: string;
  platform: Platform;
  externalAccountId: string;
  name: string;
  /** Credencial **corrente**, substituível — nunca parte da identidade (P10). */
  integrationId: string | null;
  /**
   * O status da credencial corrente. Nulo quando não há credencial.
   *
   * Viaja com a conta porque o worker decide por ele **antes** de gastar
   * chamada: token vencido ou integração desconectada não são lidos.
   */
  integrationStatus: IntegrationStatus | null;
  currency: string;
  timezone: string;
  attributionWindowDays: number | null;
  restatementWindowDays: number;
  syncHealth: AdAccountSyncHealth;
  syncHealthReason: string | null;
  unreachableSince: Date | null;
  lastSuccessfulFullSyncAt: Date | null;
  lastFullSyncAt: Date | null;
  /** Moeda-base da organização (R-M) — o alvo da normalização de toda linha. */
  baseCurrency: string;
  /**
   * §8.7: em `RECOMPUTING_CURRENCY` a inteligência pausa e o ingest **roda sem
   * normalizar** — a moeda-base está sendo reescrita, e gravar contra a antiga
   * produziria linhas que a migração não sabe que precisa corrigir.
   */
  currencyState: 'STABLE' | 'RECOMPUTING_CURRENCY';
};

export type AdAccountHealthUpdate = {
  health: AdAccountSyncHealth;
  reason: SyncHealthReason | null;
  unreachableSince: Date | null;
  lastSuccessfulFullSyncAt?: Date | null;
  lastFullSyncAt?: Date | null;
};

export type DiscoveredAdAccount = {
  organizationId: string;
  accountId: string;
  platform: Platform;
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  integrationId: string;
  attributionWindowDays?: number | null;
};

export type UpsertedAdAccount = {
  id: string;
  /** `true` quando a conta entrou agora — é o que dispara `ad_account.discovered`. */
  created: boolean;
  /** `true` quando a conta já existia e apenas trocou de credencial (REBIND). */
  rebound: boolean;
};

export abstract class AdAccountsSyncRepositoryInterface {
  abstract findById(adAccountId: string): Promise<SyncableAdAccount | null>;

  /**
   * As contas que o cron percorre: credencial que ainda se lê, organização que
   * existe, conta não congelada.
   *
   * `credential: 'ANY_LINKED'` devolve também as presas a uma credencial com
   * token vencido ou desconectada — é o que o rebind precisa para declarar quem a
   * credencial nova não alcança.
   */
  abstract listSyncable(input?: {
    organizationId?: string;
    integrationId?: string;
    credential?: 'SYNCABLE' | 'ANY_LINKED';
  }): Promise<SyncableAdAccount[]>;

  abstract listByIntegration(
    integrationId: string,
  ): Promise<SyncableAdAccount[]>;

  /**
   * Casa por `(organizationId, platform, externalAccountId)` — **nunca por
   * `integrationId`** (P10, §8.6).
   *
   * É esta assinatura que faz o rebind preservar identidade: a credencial é
   * atributo corrente da conta, e trocá-la não pode recriar nem um `Ad`, nem uma
   * linha de série, nem um id que o usuário já viu.
   */
  abstract upsertDiscovered(
    account: DiscoveredAdAccount,
    options?: {
      /**
       * `false` não religa conta desvinculada. A descoberta diária passa `false`:
       * desvincular é decisão do usuário. O rebind fica no padrão, `true`,
       * porque religar é exatamente o que ele foi chamado para fazer.
       */
      relinkDetached?: boolean;
    },
  ): Promise<UpsertedAdAccount>;

  abstract updateHealth(
    adAccountId: string,
    update: AdAccountHealthUpdate,
  ): Promise<void>;

  /** A janela de re-declaração derivada da atribuição lida da plataforma. */
  abstract updateRestatementWindow(
    adAccountId: string,
    input: {
      attributionWindowDays: number | null;
      restatementWindowDays: number;
    },
  ): Promise<void>;

  /**
   * Desvincula a credencial da conta sem apagar nada.
   *
   * Perder acesso é evento de **visibilidade**, não de mídia: os anúncios
   * continuam existindo e gastando. Por isso o caminho é `integrationId = null`
   * + `UNREACHABLE`, e nunca `delete`.
   */
  abstract detachIntegration(adAccountId: string): Promise<void>;
}
