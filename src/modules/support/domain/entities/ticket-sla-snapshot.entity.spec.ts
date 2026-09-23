import {
  ObservedTicket,
  TicketSlaSnapshot,
} from './ticket-sla-snapshot.entity';

const OPENED = new Date('2026-09-23T10:00:00Z');
const TARGETS = { firstResponseMinutes: 60, resolutionMinutes: 240 };
const minutes = (value: number) => new Date(OPENED.getTime() + value * 60_000);

function ticket(overrides: Partial<ObservedTicket> = {}): ObservedTicket {
  return {
    id: 'ticket-1',
    status: 'OPEN',
    priority: 'HIGH',
    category: null,
    assigneeId: null,
    createdAt: OPENED,
    lastMessageAt: OPENED,
    resolvedAt: null,
    messages: [{ kind: 'CUSTOMER', createdAt: OPENED }],
    ...overrides,
  };
}

describe('TicketSlaSnapshot', () => {
  it('fixa os prazos a partir da abertura do chamado', () => {
    const snapshot = TicketSlaSnapshot.open(ticket(), TARGETS);

    expect(snapshot.dueFirstResponseAt).toEqual(minutes(60));
    expect(snapshot.dueResolutionAt).toEqual(minutes(240));
    expect(snapshot.lastMessageKind).toBe('CUSTOMER');
  });

  it('a listagem sem mensagens não apaga o que o detalhe já disse', () => {
    const snapshot = TicketSlaSnapshot.open(ticket(), TARGETS);

    snapshot.observe(ticket({ messages: null }), minutes(5));

    expect(snapshot.lastMessageKind).toBe('CUSTOMER');
  });

  it('a primeira resposta do operador é registrada uma vez só', () => {
    const snapshot = TicketSlaSnapshot.open(ticket(), TARGETS);

    snapshot.observe(
      ticket({
        messages: [
          { kind: 'CUSTOMER', createdAt: OPENED },
          { kind: 'OPERATOR', createdAt: minutes(30) },
        ],
      }),
    );
    snapshot.observe(
      ticket({
        messages: [
          { kind: 'OPERATOR', createdAt: minutes(45) },
          { kind: 'CUSTOMER', createdAt: minutes(50) },
        ],
      }),
    );

    expect(snapshot.firstOperatorReplyAt).toEqual(minutes(30));
    expect(snapshot.lastMessageKind).toBe('CUSTOMER');
  });

  it('resolvido guarda o instante uma vez; reaberto volta a correr', () => {
    const snapshot = TicketSlaSnapshot.open(ticket(), TARGETS);

    snapshot.observe(
      ticket({ status: 'RESOLVED', resolvedAt: minutes(100) }),
      minutes(110),
    );
    snapshot.observe(ticket({ status: 'CLOSED' }), minutes(500));
    expect(snapshot.resolvedAt).toEqual(minutes(100));

    snapshot.observe(ticket({ status: 'OPEN' }), minutes(600));
    expect(snapshot.resolvedAt).toBeNull();
  });

  it('respondido dentro do prazo não conta mais a primeira resposta', () => {
    const snapshot = TicketSlaSnapshot.open(
      ticket({
        messages: [{ kind: 'OPERATOR', createdAt: minutes(10) }],
      }),
      TARGETS,
    );

    // Primeira resposta venceu aos 60 min, mas foi dada aos 10: não conta.
    // Resta a resolução (240), a menos de duas horas.
    const view = snapshot.slaView(minutes(130));

    expect(view.state).toBe('AT_RISK');
    expect(view.nextDueAt).toEqual(minutes(240));
  });

  it('chamado encerrado não fica estourado para sempre na fila', () => {
    const snapshot = TicketSlaSnapshot.open(
      ticket({ status: 'RESOLVED', resolvedAt: minutes(300) }),
      TARGETS,
    );

    const view = snapshot.slaView(minutes(1_000));

    expect(view.state).toBe('ON_TRACK');
    expect(view.nextDueAt).toBeNull();
  });

  it('prazo pendente vencido é BREACHED', () => {
    const snapshot = TicketSlaSnapshot.open(ticket(), TARGETS);

    expect(snapshot.slaView(minutes(61)).state).toBe('BREACHED');
  });
});
