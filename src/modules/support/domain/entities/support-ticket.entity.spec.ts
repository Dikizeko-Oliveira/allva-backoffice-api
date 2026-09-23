import { SupportTicket, clampPriority } from './support-ticket.entity';

function buildProps() {
  return {
    accountId: 'acc-1',
    organizationId: 'org-1',
    authorName: 'Ana',
    authorEmail: 'ana@empresa.com',
    subject: 'Não consigo conectar minha conta',
    message: 'O botão de conectar não responde.',
    priority: 'MEDIUM' as const,
  };
}

describe('SupportTicket', () => {
  it('nasce OPEN, sem operador e com categoria GENERAL por padrão', () => {
    const ticket = SupportTicket.create(buildProps());

    expect(ticket.status).toBe('OPEN');
    expect(ticket.operatorId).toBeNull();
    expect(ticket.category).toBe('GENERAL');
  });

  it('o código segue SUP-YYYYMMDD-XXXX, com sufixo sem caracteres ambíguos', () => {
    const ticket = SupportTicket.create(buildProps());

    expect(ticket.code).toMatch(/^SUP-\d{8}-[A-HJ-NP-Z2-9]{4}$/);

    // O sufixo — não a data, que legitimamente contém 0/1/2/8 — é o que
    // precisa evitar 0/O e 1/I: é ele que alguém lê em voz alta ao telefone.
    const suffix = ticket.code.split('-')[2];
    expect(suffix).not.toMatch(/[01OI]/);
  });

  it('dois chamados criados em sequência recebem códigos diferentes', () => {
    const a = SupportTicket.create(buildProps());
    const b = SupportTicket.create(buildProps());

    expect(a.code).not.toBe(b.code);
    expect(a.id).not.toBe(b.id);
  });

  it('a prioridade é a que foi passada na criação, sem regra própria', () => {
    const high = SupportTicket.create({ ...buildProps(), priority: 'HIGH' });
    expect(high.priority).toBe('HIGH');
  });

  it('sem anexo, os quatro campos de attachment nascem null', () => {
    const ticket = SupportTicket.create(buildProps());

    expect(ticket.attachmentUrl).toBeNull();
    expect(ticket.attachmentKey).toBeNull();
    expect(ticket.attachmentStorageProvider).toBeNull();
    expect(ticket.attachmentFilename).toBeNull();
    expect(ticket.hasAttachment).toBe(false);
  });

  it('com anexo, os quatro campos nascem juntos', () => {
    const ticket = SupportTicket.create({
      ...buildProps(),
      attachment: {
        url: 'https://storage.googleapis.com/bucket/print.png',
        key: 'support-tickets/org-1/print-abc123.png',
        storageProvider: 'gcs',
        filename: 'print.png',
      },
    });

    expect(ticket.attachmentUrl).toBe(
      'https://storage.googleapis.com/bucket/print.png',
    );
    expect(ticket.attachmentKey).toBe('support-tickets/org-1/print-abc123.png');
    expect(ticket.attachmentStorageProvider).toBe('gcs');
    expect(ticket.attachmentFilename).toBe('print.png');
    expect(ticket.hasAttachment).toBe(true);
    // Nome do operador é `join`, não coluna: um chamado recém-criado não tem
    // operador, e portanto também não tem nome de operador.
    expect(ticket.operatorName).toBeNull();
  });

  it('restore reidrata os campos sem recalcular nada', () => {
    const now = new Date('2026-08-28T14:32:00.000Z');
    const ticket = SupportTicket.restore({
      id: 'ticket-1',
      code: 'SUP-20260828-7K4N',
      accountId: 'acc-1',
      organizationId: 'org-1',
      authorName: 'Ana',
      authorEmail: 'ana@empresa.com',
      operatorId: 'operator-1',
      operatorName: 'Rafael',
      subject: 'Assunto',
      message: 'Mensagem',
      category: 'BILLING',
      priority: 'CRITICAL',
      status: 'IN_PROGRESS',
      attachmentUrl: 'https://storage.googleapis.com/bucket/print.png',
      attachmentKey: 'support-tickets/org-1/print-abc123.png',
      attachmentStorageProvider: 'gcs',
      attachmentFilename: 'print.png',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      resolvedAt: null,
      statusChangedAt: null,
    });

    expect(ticket.toJSON()).toEqual({
      id: 'ticket-1',
      code: 'SUP-20260828-7K4N',
      accountId: 'acc-1',
      organizationId: 'org-1',
      authorName: 'Ana',
      authorEmail: 'ana@empresa.com',
      operatorId: 'operator-1',
      operatorName: 'Rafael',
      subject: 'Assunto',
      message: 'Mensagem',
      category: 'BILLING',
      priority: 'CRITICAL',
      status: 'IN_PROGRESS',
      attachmentUrl: 'https://storage.googleapis.com/bucket/print.png',
      attachmentFilename: 'print.png',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      resolvedAt: null,
      statusChangedAt: null,
    });
  });
});

/**
 * A prioridade passou a ter duas fontes — o que o solicitante declara e o que
 * o plano concede —, e o teto é o que impede a primeira de anular a segunda.
 */
describe('clampPriority', () => {
  it('respeita a declaração quando ela cabe no teto', () => {
    expect(clampPriority('LOW', 'CRITICAL')).toBe('LOW');
    expect(clampPriority('HIGH', 'CRITICAL')).toBe('HIGH');
    expect(clampPriority('MEDIUM', 'MEDIUM')).toBe('MEDIUM');
  });

  it('sem `support-priority`, urgência declarada não fura a fila', () => {
    expect(clampPriority('CRITICAL', 'MEDIUM')).toBe('MEDIUM');
    expect(clampPriority('HIGH', 'MEDIUM')).toBe('MEDIUM');
  });

  /**
   * O teto corta para cima, nunca para baixo: quem diz "isto é pouco urgente"
   * está dando uma informação verdadeira, e ignorá-la por não ter a linha no
   * plano transformaria todo chamado do Individual em MEDIUM.
   */
  it('o teto não empurra a prioridade para cima', () => {
    expect(clampPriority('LOW', 'MEDIUM')).toBe('LOW');
  });
});

/**
 * Os carimbos que o painel de operador move. São a diferença entre o
 * histórico dizer a verdade e dizer a hora da última mensagem.
 */
describe('transições do chamado', () => {
  function build() {
    return SupportTicket.create(buildProps());
  }

  it('o chamado nasce sem carimbo de resolução nem de mudança de status', () => {
    const ticket = build();

    expect(ticket.status).toBe('OPEN');
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.statusChangedAt).toBeNull();
    // A conversa começa com a mensagem que abriu o chamado.
    expect(ticket.lastMessageAt).toEqual(ticket.createdAt);
  });

  it('resolver carimba `resolvedAt` e `statusChangedAt`', () => {
    const ticket = build();
    const now = new Date('2026-09-20T12:00:00.000Z');

    ticket.changeStatus('RESOLVED', now);

    expect(ticket.status).toBe('RESOLVED');
    expect(ticket.resolvedAt).toEqual(now);
    expect(ticket.statusChangedAt).toEqual(now);
  });

  /**
   * Sem esta limpeza, o chamado reaberto continuaria contando na média de
   * tempo de resolução — e contaria com o tempo da resolução que não valeu.
   */
  it('reabrir limpa `resolvedAt`', () => {
    const ticket = build();

    ticket.changeStatus('RESOLVED', new Date('2026-09-20T12:00:00.000Z'));
    ticket.changeStatus('OPEN', new Date('2026-09-21T09:00:00.000Z'));

    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.statusChangedAt).toEqual(
      new Date('2026-09-21T09:00:00.000Z'),
    );
  });

  it('resolver de novo carimba de novo — a resolução que vale é a última', () => {
    const ticket = build();
    const second = new Date('2026-09-22T10:00:00.000Z');

    ticket.changeStatus('RESOLVED', new Date('2026-09-20T12:00:00.000Z'));
    ticket.changeStatus('OPEN', new Date('2026-09-21T09:00:00.000Z'));
    ticket.changeStatus('CLOSED', second);

    expect(ticket.resolvedAt).toEqual(second);
  });

  /**
   * O duplo clique no `<select>` do painel: sem a guarda, reescreveria os
   * carimbos e moveria a resolução para agora.
   */
  it('repetir o status atual não mexe em carimbo nenhum', () => {
    const ticket = build();
    const first = new Date('2026-09-20T12:00:00.000Z');

    ticket.changeStatus('RESOLVED', first);
    ticket.changeStatus('RESOLVED', new Date('2026-09-20T18:00:00.000Z'));

    expect(ticket.resolvedAt).toEqual(first);
    expect(ticket.statusChangedAt).toEqual(first);
  });

  it('atribuir troca o responsável e zera o nome de exibição', () => {
    const ticket = build();

    ticket.assignTo('operator-1');

    expect(ticket.operatorId).toBe('operator-1');
    // Vem de `join`; devolver o anterior ao lado do id novo seria pior que nulo.
    expect(ticket.operatorName).toBeNull();

    ticket.assignTo(null);
    expect(ticket.operatorId).toBeNull();
  });

  it('`registerMessage` move só o "falou por último", não o status', () => {
    const ticket = build();
    const now = new Date('2026-09-21T15:00:00.000Z');

    ticket.registerMessage(now);

    expect(ticket.lastMessageAt).toEqual(now);
    expect(ticket.status).toBe('OPEN');
    expect(ticket.statusChangedAt).toBeNull();
  });
});
