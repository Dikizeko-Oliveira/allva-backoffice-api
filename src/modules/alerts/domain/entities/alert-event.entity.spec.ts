import { AlertEvent } from './alert-event.entity';

const event = () =>
  AlertEvent.restore({
    id: 'event-1',
    ruleId: 'rule-1',
    requiredPermission: 'billing:read',
    source: 'billing.invoices_overdue',
    severity: 'CRITICAL',
    payload: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    createdAt: new Date('2026-09-23T10:00:00Z'),
  });

describe('AlertEvent', () => {
  it('reconhecer de novo não troca quem reconheceu primeiro', () => {
    const subject = event();
    const first = new Date('2026-09-23T11:00:00Z');

    subject.acknowledge('op-1', first);
    subject.acknowledge('op-2', new Date('2026-09-23T12:00:00Z'));

    expect(subject.acknowledgedBy).toBe('op-1');
    expect(subject.acknowledgedAt).toEqual(first);
  });
});
