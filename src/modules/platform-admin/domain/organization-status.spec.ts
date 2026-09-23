import {
  ORGANIZATION_STATUSES,
  billingStatusesFor,
  organizationStatusOf,
} from './organization-status';

const BILLING_STATUSES = [
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
];

describe('estado derivado da organização', () => {
  it('todo status de assinatura do banco tem um estado', () => {
    for (const billing of BILLING_STATUSES) {
      expect(organizationStatusOf(billing)).not.toBe('NO_SUBSCRIPTION');
    }
  });

  it('sem assinatura é declarado, não escondido', () => {
    expect(organizationStatusOf(null)).toBe('NO_SUBSCRIPTION');
    expect(billingStatusesFor('NO_SUBSCRIPTION')).toEqual([]);
  });

  it('o filtro inverso volta ao mesmo estado', () => {
    for (const status of ORGANIZATION_STATUSES) {
      for (const billing of billingStatusesFor(status)) {
        expect(organizationStatusOf(billing)).toBe(status);
      }
    }
  });

  it('inadimplência junta PAST_DUE e UNPAID', () => {
    expect(billingStatusesFor('PAST_DUE').sort()).toEqual([
      'PAST_DUE',
      'UNPAID',
    ]);
  });
});
