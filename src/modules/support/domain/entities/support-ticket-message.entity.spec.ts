import {
  CUSTOMER_VISIBLE_MESSAGE_KINDS,
  SupportTicketMessage,
  SupportTicketMessageKindValues,
  isCustomerVisible,
} from './support-ticket-message.entity';

describe('visibilidade da mensagem', () => {
  /**
   * A regra que separa a nota interna do resto. Ela mora numa constante, e
   * não num `filter` por rota, justamente para este teste existir num lugar
   * só — e para a terceira rota de cliente não precisar lembrar dela.
   */
  it('a nota interna nunca é visível ao cliente', () => {
    expect(isCustomerVisible('INTERNAL_NOTE')).toBe(false);
    expect(CUSTOMER_VISIBLE_MESSAGE_KINDS).not.toContain('INTERNAL_NOTE');
  });

  it('cliente e operador são', () => {
    expect(isCustomerVisible('CUSTOMER')).toBe(true);
    expect(isCustomerVisible('OPERATOR')).toBe(true);
  });

  /**
   * Se um tipo novo entrar no enum sem decisão explícita de visibilidade,
   * este teste é o que cobra a decisão — em vez de o tipo aparecer na tela do
   * cliente por ser o default de um `filter` permissivo.
   */
  it('todo tipo do enum está classificado de um lado ou do outro', () => {
    for (const kind of SupportTicketMessageKindValues) {
      expect(typeof isCustomerVisible(kind)).toBe('boolean');
    }

    expect(SupportTicketMessageKindValues).toHaveLength(3);
  });
});

describe('SupportTicketMessage', () => {
  it('create carimba id e data, e preserva o autor', () => {
    const now = new Date('2026-09-21T10:00:00.000Z');

    const message = SupportTicketMessage.create(
      {
        ticketId: 'tic-1',
        kind: 'OPERATOR',
        authorId: 'op-1',
        authorName: 'Camila Duarte',
        body: 'Token renovado.',
      },
      now,
    );

    expect(message.id).toHaveLength(36);
    expect(message.createdAt).toEqual(now);
    expect(message.authorName).toBe('Camila Duarte');
    expect(message.isCustomerVisible).toBe(true);
  });
});
