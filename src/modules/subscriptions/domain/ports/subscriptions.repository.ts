import { Subscription } from '../entities';
import { BillingStatus } from 'src/modules/subscriptions/access/domain/access-status';

export abstract class SubscriptionsRepositoryInterface {
  abstract findByAccountId(accountId: string): Promise<Subscription | null>;
  abstract findById(id: string): Promise<Subscription | null>;
  abstract findByExternalSubscriptionId(
    externalSubscriptionId: string,
  ): Promise<Subscription | null>;
  abstract findByExternalReference(
    externalReference: string,
  ): Promise<Subscription | null>;
  abstract listForReconciliation(
    statuses: BillingStatus[],
    limit?: number,
  ): Promise<Subscription[]>;
  abstract save(subscription: Subscription): Promise<void>;
  /**
   * Desfaz uma reserva que nunca chegou a virar assinatura no provedor.
   *
   * `CreateSubscriptionUseCase` grava a linha **antes** de falar com a Stripe,
   * usando a unicidade de `account_id` como trava contra cobrança dupla. Se a
   * Stripe recusar, a vaga precisa ser devolvida — senão a conta fica presa numa
   * assinatura fantasma que nenhum caminho consegue pagar nem recriar.
   */
  abstract deleteById(id: string): Promise<void>;
  abstract update(subscription: Subscription): Promise<void>;
}
