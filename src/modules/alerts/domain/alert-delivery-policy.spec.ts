import {
  AlertDeliveryInput,
  alertFingerprint,
  decideAlertDelivery,
} from './alert-delivery-policy';

const OPEN_CRITICAL: AlertDeliveryInput = {
  severity: 'CRITICAL',
  recipientEmail: 'user@example.com',
};

describe('decideAlertDelivery', () => {
  it.each(['CRITICAL', 'WARNING'] as const)(
    'delivers a %s alert',
    (severity) => {
      expect(decideAlertDelivery({ ...OPEN_CRITICAL, severity })).toEqual({
        deliver: true,
      });
    },
  );

  // The rule that keeps alert email worth reading: if INFO were emailed, users
  // would filter the whole sender and miss the CRITICAL ones.
  it('never emails an INFO alert', () => {
    expect(decideAlertDelivery({ ...OPEN_CRITICAL, severity: 'INFO' })).toEqual(
      {
        deliver: false,
        reason: 'severity_below_threshold',
      },
    );
  });

  it('does not re-notify an alert that was already emailed', () => {
    expect(
      decideAlertDelivery({ ...OPEN_CRITICAL, notifiedAt: new Date() }),
    ).toEqual({ deliver: false, reason: 'already_notified' });
  });

  it.each([
    ['dismissed', { dismissedAt: new Date() }],
    ['resolved', { resolvedAt: new Date() }],
  ])('does not email an alert that arrives already %s', (_name, closed) => {
    expect(decideAlertDelivery({ ...OPEN_CRITICAL, ...closed })).toEqual({
      deliver: false,
      reason: 'alert_not_open',
    });
  });

  it.each([undefined, null, '', '   '])(
    'reports a missing recipient (%p) instead of attempting a send',
    (recipientEmail) => {
      expect(decideAlertDelivery({ ...OPEN_CRITICAL, recipientEmail })).toEqual(
        { deliver: false, reason: 'missing_recipient' },
      );
    },
  );

  // Ordering matters for the logs: a closed INFO alert should report the more
  // specific reason, not the severity one.
  it('reports the recipient problem before anything else', () => {
    expect(
      decideAlertDelivery({
        severity: 'INFO',
        recipientEmail: null,
        resolvedAt: new Date(),
      }),
    ).toEqual({ deliver: false, reason: 'missing_recipient' });
  });
});

describe('alertFingerprint', () => {
  const base = {
    organizationId: 'org-1',
    type: 'WASTE_DETECTED',
    subject: { kind: 'WASTE_ITEM', wasteItemId: 'waste-42' } as const,
    title: 'Desperdicio critico detectado',
  };

  it('is stable for the same problem reported twice', () => {
    expect(alertFingerprint(base)).toBe(alertFingerprint({ ...base }));
  });

  /**
   * A razão de existir: a detecção roda diariamente e re-reporta condições
   * persistentes. O texto pode mudar entre execuções; o fingerprint não pode, ou
   * toda manhã produziria um alerta novo e um e-mail novo.
   */
  it('ignores the title when the subject identifies the problem', () => {
    expect(alertFingerprint({ ...base, title: 'Texto reescrito' })).toBe(
      alertFingerprint(base),
    );
  });

  it('falls back to the title for account-wide subjects', () => {
    const accountWide = {
      ...base,
      type: 'SYNC_QUARANTINE',
      subject: { kind: 'AD_ACCOUNT', adAccountId: 'acc-1' } as const,
    };

    expect(alertFingerprint(accountWide)).not.toBe(
      alertFingerprint({ ...accountWide, title: 'Outro problema' }),
    );
  });

  it('normalises case and whitespace in the title fallback', () => {
    const accountWide = {
      ...base,
      subject: { kind: 'AD_ACCOUNT', adAccountId: 'acc-1' } as const,
    };

    expect(
      alertFingerprint({
        ...accountWide,
        title: '  DESPERDICIO Critico Detectado  ',
      }),
    ).toBe(
      alertFingerprint({
        ...accountWide,
        title: 'desperdicio critico detectado',
      }),
    );
  });

  it.each([
    ['organizationId', { organizationId: 'org-2' }],
    ['type', { type: 'BUDGET_ALERT' }],
    [
      'subject id',
      { subject: { kind: 'WASTE_ITEM', wasteItemId: 'waste-43' } as const },
    ],
    ['subject kind', { subject: { kind: 'AD', adId: 'waste-42' } as const }],
  ])('separates alerts that differ by %s', (_name, override) => {
    expect(alertFingerprint({ ...base, ...override })).not.toBe(
      alertFingerprint(base),
    );
  });

  /**
   * O bug que este modelo existe para impedir: no v1, um alerta com
   * `referenceType` preenchido e `referenceId` nulo colapsava com todos os outros
   * do mesmo tipo. Aqui o sujeito é tipado e o id é obrigatório dentro dele —
   * "sujeito pela metade" não é representável.
   */
  it('cannot produce a fingerprint without a subject id', () => {
    const ads = ['ad-1', 'ad-2'].map((adId) =>
      alertFingerprint({ ...base, subject: { kind: 'AD', adId } }),
    );

    expect(new Set(ads).size).toBe(2);
  });
});
