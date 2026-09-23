/**
 * O estado de uma organização como o operador o procura numa lista.
 *
 * É **derivado**, não uma coluna. A verdade mora em
 * `organization_subscriptions.status` (dez valores, do ponto de vista da
 * cobrança), e nenhum deles responde sozinho a "este cliente está usando?".
 * A redução é a que o backoffice já documentava para o dia em que o endpoint
 * existisse:
 *
 * | status da assinatura                     | aqui                 |
 * |------------------------------------------|----------------------|
 * | `TRIALING`                               | `TRIAL`              |
 * | `ACTIVE`                                 | `ACTIVE`             |
 * | `PENDING_ACTIVATION`, `PENDING_PAYMENT`, `INCOMPLETE` | `PENDING_ACTIVATION` |
 * | `PAST_DUE`, `UNPAID`                     | `PAST_DUE`           |
 * | `PAUSED`                                 | `SUSPENDED`          |
 * | `CANCELED`, `EXPIRED`                    | `CANCELED`           |
 * | sem assinatura                           | `NO_SUBSCRIPTION`    |
 *
 * `NO_SUBSCRIPTION` é novo em relação ao mock do backoffice: ele não tinha
 * como existir numa lista inventada, e existe no banco — uma organização cujo
 * provisionamento parou no meio. Escondê-la num dos outros seis faria o
 * operador procurar a conta no lugar errado.
 */
export const ORGANIZATION_STATUSES = [
  'ACTIVE',
  'TRIAL',
  'PENDING_ACTIVATION',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELED',
  'NO_SUBSCRIPTION',
] as const;

export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

const BY_BILLING_STATUS: Record<string, OrganizationStatus> = {
  TRIALING: 'TRIAL',
  ACTIVE: 'ACTIVE',
  PENDING_ACTIVATION: 'PENDING_ACTIVATION',
  PENDING_PAYMENT: 'PENDING_ACTIVATION',
  INCOMPLETE: 'PENDING_ACTIVATION',
  PAST_DUE: 'PAST_DUE',
  UNPAID: 'PAST_DUE',
  PAUSED: 'SUSPENDED',
  CANCELED: 'CANCELED',
  EXPIRED: 'CANCELED',
};

export function organizationStatusOf(
  billingStatus: string | null | undefined,
): OrganizationStatus {
  if (!billingStatus) return 'NO_SUBSCRIPTION';
  return BY_BILLING_STATUS[billingStatus] ?? 'NO_SUBSCRIPTION';
}

/**
 * O caminho inverso, para filtrar no banco: os status de assinatura que caem
 * em cada estado. `NO_SUBSCRIPTION` devolve lista vazia — quem filtra por ele
 * procura a ausência da linha, não um valor dela.
 */
export function billingStatusesFor(status: OrganizationStatus): string[] {
  return Object.entries(BY_BILLING_STATUS)
    .filter(([, derived]) => derived === status)
    .map(([billing]) => billing);
}
