export const BillingStatusValues = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PENDING_PAYMENT',
  'PENDING_ACTIVATION',
  'PAUSED',
  'CANCELED',
  'EXPIRED',
  'UNPAID',
  'INCOMPLETE',
] as const;

export type BillingStatus = (typeof BillingStatusValues)[number];

export const AccessStatusValues = [
  'ALLOWED',
  'GRACE_PERIOD',
  'PAYMENT_REQUIRED',
  'PENDING_ACTIVATION',
  'BLOCKED',
] as const;

export type AccessStatus = (typeof AccessStatusValues)[number];

/**
 * Maior = mais acesso.
 *
 * Mora no domínio, e não dentro do resolver, porque há dois leitores da mesma
 * ordem: o resolver, que devolve o contexto mais permissivo entre conta e
 * organização, e a varredura dos jobs, que precisa saber se **algum** desses
 * caminhos ainda abre o produto. Duas tabelas divergiriam na primeira mudança.
 */
export const ACCESS_RANK: Readonly<Record<AccessStatus, number>> = {
  ALLOWED: 5,
  GRACE_PERIOD: 4,
  PENDING_ACTIVATION: 3,
  PAYMENT_REQUIRED: 2,
  BLOCKED: 1,
};

export function mapBillingToAccess(
  billing: BillingStatus | null | undefined,
): AccessStatus {
  if (!billing) return 'BLOCKED';

  switch (billing) {
    case 'ACTIVE':
    case 'TRIALING':
      return 'ALLOWED';
    case 'PAST_DUE':
      return 'GRACE_PERIOD';
    case 'PENDING_PAYMENT':
    case 'PENDING_ACTIVATION':
      return 'PENDING_ACTIVATION';
    case 'CANCELED':
    case 'EXPIRED':
    case 'UNPAID':
    case 'INCOMPLETE':
    case 'PAUSED':
      return 'PAYMENT_REQUIRED';
    default:
      return 'BLOCKED';
  }
}
