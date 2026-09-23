import { AlertDTO } from 'src/modules/alerts/domain/ports/alerts.repository';
import { AlertNotifierService } from './alert-notifier.service';

function buildAlert(overrides: Partial<AlertDTO> = {}): AlertDTO {
  return {
    id: 'alert-1',
    organizationId: 'org-1',
    type: 'WASTE_DETECTED',
    severity: 'CRITICAL',
    title: 'Desperdicio critico detectado',
    message: 'Campanha X gastou R$ 1.200 sem conversao.',
    subject: { kind: 'WASTE_ITEM', wasteItemId: 'waste-42' },
    isRead: false,
    readAt: null,
    dismissedAt: null,
    resolvedAt: null,
    notifiedAt: null,
    occurrences: 1,
    firstOccurredAt: new Date('2026-07-25T10:00:00.000Z'),
    lastOccurredAt: new Date('2026-07-25T10:00:00.000Z'),
    createdAt: new Date('2026-07-25T10:00:00.000Z'),
    ...overrides,
  };
}

function buildHarness({
  allowed = true,
  recipient = {
    accountId: 'acc-1',
    email: 'user@example.com',
    name: 'Ana',
  } as {
    accountId: string;
    email: string;
    name: string;
  } | null,
  sendFails = false,
  planCovers = true,
}: {
  allowed?: boolean;
  recipient?: { email: string; name: string } | null;
  sendFails?: boolean;
  /** O plano cobre email para a severidade do alerta. */
  planCovers?: boolean;
} = {}) {
  const markNotified = jest.fn().mockResolvedValue(undefined);
  const alertsRepository = { markNotified } as never;

  const canSend = jest.fn().mockResolvedValue(allowed);
  const preferenceGate = { canSend } as never;

  const send = jest
    .fn()
    .mockImplementation(() =>
      sendFails ? Promise.reject(new Error('smtp down')) : Promise.resolve(),
    );
  const emailSender = { send } as never;

  const resolve = jest.fn().mockResolvedValue(recipient);
  const recipients = { resolve } as never;

  const itemStateFor = jest.fn().mockResolvedValue(
    planCovers
      ? { allowed: true }
      : {
          allowed: false,
          planLabel: 'Individual',
          featureLabel: 'Alertas de desperdício por email',
          upgradeTo: 'Profissional',
        },
  );
  const plans = { itemStateFor };

  const appUrl = {
    baseUrl: 'https://app.test',
    pathTo: (path: string) => `https://app.test/${path.replace(/^\/+/, '')}`,
  };

  const service = new AlertNotifierService(
    alertsRepository,
    preferenceGate,
    emailSender,
    recipients,
    appUrl as never,
    plans as never,
  );

  for (const level of ['log', 'error', 'debug'] as const) {
    jest
      .spyOn((service as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return { service, send, canSend, markNotified, itemStateFor };
}

describe('AlertNotifierService', () => {
  it('delivers a critical alert and records that it did', async () => {
    const h = buildHarness();

    await expect(h.service.notify(buildAlert())).resolves.toEqual({
      delivered: true,
    });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.markNotified).toHaveBeenCalledWith('alert-1', expect.any(Date));
  });

  it('addresses the mail to the resolved recipient with the severity in the subject', async () => {
    const h = buildHarness();

    await h.service.notify(buildAlert());

    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: expect.stringContaining('Critico'),
      }),
    );
  });

  /**
   * The M-2 acceptance criterion: "alerta gera e-mail só quando a preferência permite".
   */
  it('sends nothing when the preference denies the ALERT category', async () => {
    const h = buildHarness({ allowed: false });

    await expect(h.service.notify(buildAlert())).resolves.toEqual({
      delivered: false,
      reason: 'preference_denied',
    });

    expect(h.send).not.toHaveBeenCalled();
    expect(h.markNotified).not.toHaveBeenCalled();
  });

  it('asks the gate about the ALERT category specifically', async () => {
    const h = buildHarness();

    await h.service.notify(buildAlert());

    expect(h.canSend).toHaveBeenCalledWith('acc-1', 'ALERT');
  });

  it('never emails an INFO alert, and does not even consult preferences', async () => {
    const h = buildHarness();

    await expect(
      h.service.notify(buildAlert({ severity: 'INFO' })),
    ).resolves.toEqual({
      delivered: false,
      reason: 'severity_below_threshold',
    });

    expect(h.send).not.toHaveBeenCalled();
    expect(h.canSend).not.toHaveBeenCalled();
  });

  it('does not re-notify an alert already emailed', async () => {
    const h = buildHarness();

    await h.service.notify(buildAlert({ notifiedAt: new Date() }));

    expect(h.send).not.toHaveBeenCalled();
  });

  it('skips an account with no email address', async () => {
    const h = buildHarness({ recipient: null });

    await expect(h.service.notify(buildAlert())).resolves.toEqual({
      delivered: false,
      reason: 'missing_recipient',
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  /**
   * The alert already exists in-app at this point. Throwing would fail the pipeline
   * that raised it — losing the alert entirely over a mail problem.
   */
  it('never throws when the mail provider fails', async () => {
    const h = buildHarness({ sendFails: true });

    await expect(h.service.notify(buildAlert())).resolves.toEqual({
      delivered: false,
      reason: 'send_failed',
    });
  });

  it('does not mark the alert notified when the send failed', async () => {
    const h = buildHarness({ sendFails: true });

    await h.service.notify(buildAlert());

    // Leaving `notifiedAt` null lets a later recurrence retry the delivery.
    expect(h.markNotified).not.toHaveBeenCalled();
  });
});

/**
 * O corte de plano por severidade — o Individual recebe só o crítico.
 *
 * O alerta continua existindo e aparecendo no app em qualquer plano; o que o
 * plano governa é sair do app e chegar por email.
 */
describe('corte por plano', () => {
  it('não envia quando o plano não cobre a severidade', async () => {
    const h = buildHarness({ planCovers: false });

    await expect(h.service.notify(buildAlert())).resolves.toEqual({
      delivered: false,
      reason: 'plan_severity',
    });

    expect(h.send).not.toHaveBeenCalled();
    // Sem `markNotified`: o alerta não foi entregue, e marcá-lo impediria a
    // entrega numa eventual subida de plano.
    expect(h.markNotified).not.toHaveBeenCalled();
  });

  it('alerta de integridade ignora o plano — silenciá-lo esconderia um defeito', async () => {
    const h = buildHarness({ planCovers: false });

    await expect(
      h.service.notify(buildAlert({ type: 'INTEGRATION_DISCONNECTED' })),
    ).resolves.toEqual({ delivered: true });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.itemStateFor).not.toHaveBeenCalled();
  });

  it('consulta o plano com a severidade do alerta', async () => {
    const h = buildHarness();

    await h.service.notify(buildAlert({ severity: 'WARNING' }));

    expect(h.itemStateFor).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'email-waste-alerts',
        item: 'WARNING',
      }),
    );
  });
});
