import { AdAccount, Integration } from '../entities';
import type { ProviderType } from '../entities/integration.entity';

export type IntegrationWithAdAccounts = {
  integration: Integration;
  adAccounts: AdAccount[];
};

export abstract class IntegrationsRepositoryInterface {
  abstract save(integration: Integration): Promise<void>;
  abstract update(integration: Integration): Promise<void>;
  abstract findById(id: string): Promise<Integration | null>;
  abstract findByAccountId(accountId: string): Promise<Integration | null>;
  abstract findByOrganizationId(
    organizationId: string,
  ): Promise<Integration | null>;
  abstract findByAccountAndProvider(
    accountId: string,
    providerType: ProviderType,
  ): Promise<Integration | null>;
  abstract listByAccountId(
    accountId: string,
  ): Promise<IntegrationWithAdAccounts[]>;
  abstract listByOrganizationId(
    organizationId: string,
  ): Promise<IntegrationWithAdAccounts[]>;
  abstract listAllConnected(): Promise<Integration[]>;
}
