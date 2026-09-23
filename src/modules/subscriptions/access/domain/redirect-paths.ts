import { AccessStatus } from './access-status';

export const FRONTEND_PRODUCT_REDIRECT = '/plans/subscriptions';
export const FRONTEND_BILLING_PATH = '/account/billing';
export const FRONTEND_SUBSCRIPTIONS_PATH = '/plans/subscriptions';

export function resolveDefaultRedirect(status: AccessStatus): string | null {
  switch (status) {
    case 'ALLOWED':
      return null;
    case 'GRACE_PERIOD':
    case 'PAYMENT_REQUIRED':
    case 'PENDING_ACTIVATION':
    case 'BLOCKED':
      return FRONTEND_SUBSCRIPTIONS_PATH;
    default:
      return FRONTEND_SUBSCRIPTIONS_PATH;
  }
}

/**
 * Para onde mandar quem é governado por contrato.
 *
 * Sempre a cobrança, e nunca o checkout. `/plans/subscriptions` existe para
 * contratar um plano de tabela com cartão — o cliente de contrato já tem um
 * acordo, e a própria API recusaria a troca. A cobrança é onde ele encontra a
 * fatura em aberto, a vigência e o número para citar ao comercial.
 */
export function resolveContractRedirect(status: AccessStatus): string | null {
  return status === 'ALLOWED' ? null : FRONTEND_BILLING_PATH;
}

export function resolveReasonCode(status: AccessStatus): string {
  switch (status) {
    case 'ALLOWED':
      return 'ACCESS_ALLOWED';
    case 'GRACE_PERIOD':
      return 'GRACE_PERIOD_ACTIVE';
    case 'PAYMENT_REQUIRED':
      return 'PAYMENT_REQUIRED';
    case 'PENDING_ACTIVATION':
      return 'SUBSCRIPTION_PENDING_ACTIVATION';
    case 'BLOCKED':
      return 'SUBSCRIPTION_REQUIRED';
    default:
      return 'SUBSCRIPTION_REQUIRED';
  }
}
