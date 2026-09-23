import { BillingStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { ContractTermView } from 'src/modules/subscriptions/access/domain/contract-access';

/**
 * Read model for the organization subscription that governs an account's
 * product access. Deliberately minimal: in the Stripe-first model the paid
 * billing state still lives on the per-account Subscription, so this only
 * carries what the access resolver needs to gate the product (plan + trial
 * lifecycle).
 */
/**
 * O contrato como o read model o entrega: o que decide acesso, mais o que a
 * tela de cobrança precisa dizer ao cliente.
 *
 * Estende `ContractTermView` em vez de engordá-lo. Aquele tipo é a **entrada da
 * decisão** de acesso, e misturar campos de apresentação nele faria o resolver
 * parecer depender de número de contrato e forma de pagamento — que não decidem
 * nada. Aqui os dois papéis convivem porque é uma consulta só: buscar o mesmo
 * contrato duas vezes na mesma requisição seria o preço da separação.
 */
export type OrganizationContractView = ContractTermView & {
  id: string;
  contractNumber: string;
  billingInterval: string;
  paymentTerms: string;
  paymentMethod: string;
  autoRenew: boolean;
};

export type OrganizationEntitlementView = {
  organizationSubscriptionId: string;
  organizationId: string;
  planId: string;
  planName: string | null;
  planType: string | null;
  status: BillingStatus;
  trialEndsAt: Date | null;
  /**
   * O contrato Enterprise que governa esta organização, quando há um.
   *
   * Nulo em toda organização self-serve — que é a maioria — e é o que faz o
   * resolver decidir por dois caminhos: pela assinatura, como sempre, ou pela
   * vigência do contrato quando ele existe.
   */
  contract: OrganizationContractView | null;
};

/** A TRIALING organization subscription whose trial window has elapsed. */
export type ExpiredTrialRef = {
  id: string;
  organizationId: string;
};

export abstract class OrganizationEntitlementRepositoryInterface {
  /**
   * Resolves the organization subscription that governs `accountId`'s product
   * access. When `organizationId` is provided (the request selected an org via
   * `X-Organization-Id`), that org is used; otherwise a default is chosen,
   * preferring an org the account owns over one it is an ACTIVE member of.
   * Returns null when the account has no org subscription to inherit from.
   */
  abstract findEffectiveForAccount(
    accountId: string,
    organizationId?: string | null,
  ): Promise<OrganizationEntitlementView | null>;

  /** Lists TRIALING subscriptions whose `trialEndsAt` is at or before `now`. */
  abstract listExpiredTrials(
    now: Date,
    limit: number,
  ): Promise<ExpiredTrialRef[]>;

  /** Persists the TRIALING → EXPIRED transition for a single subscription. */
  abstract markExpired(organizationSubscriptionId: string): Promise<void>;
}
