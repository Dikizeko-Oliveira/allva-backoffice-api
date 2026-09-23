import { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities';

/**
 * A entidade que os `AdsProviderGateway` esperam, montada a partir da
 * `AdAccount` v2.0.
 *
 * O gateway foi escrito para a entidade do v1 e usa dela exatamente três campos:
 * `id`, `externalAccountId` e `currency`. Retipá-lo alcançaria os três providers
 * no sprint que já é o mais denso do plano, então a adaptação fica de um lado
 * só — aqui — e desaparece quando o gateway for reescrito em A2-S7, que é
 * quando ele muda de forma de qualquer jeito.
 */
export function toProviderAdAccount(
  account: {
    id: string;
    externalAccountId: string;
    name: string;
    currency: string;
    timezone: string;
  },
  integration: Integration,
): AdAccount {
  return AdAccount.restore({
    id: account.id,
    integrationId: integration.id,
    organizationId: integration.organizationId ?? '',
    accountId: integration.accountId,
    platform: integration.providerType,
    externalAccountId: account.externalAccountId,
    name: account.name,
    currency: account.currency,
    timezone: account.timezone,
    discoveredAt: new Date(),
    frozenAt: null,
  });
}
