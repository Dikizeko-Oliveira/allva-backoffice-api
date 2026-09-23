import { BillingCard } from '../entities';

export abstract class BillingCardsRepositoryInterface {
  abstract findById(id: string): Promise<BillingCard | null>;
  abstract findByExternalCardId(
    provider: 'STRIPE',
    externalCardId: string,
  ): Promise<BillingCard | null>;
  abstract listByAccountId(accountId: string): Promise<BillingCard[]>;
  abstract save(card: BillingCard): Promise<void>;
  abstract update(card: BillingCard): Promise<void>;
  abstract clearDefaultForAccount(
    accountId: string,
    provider: 'STRIPE',
  ): Promise<void>;
}
