import { SupportTicket, SupportTicketMessage } from '../domain/entities';
import type { SupportOrganizationContext } from '../domain/ports';
import {
  AdminSupportTicketDetailOutputDto,
  AdminSupportTicketOutputDto,
  SupportTicketDetailOutputDto,
  SupportTicketEventDto,
  SupportTicketMessageDto,
  SupportTicketOutputDto,
} from './dtos';

/**
 * A linha da listagem.
 *
 * `message` fica **de fora** de propósito: são até 5.000 caracteres por
 * chamado, e a tabela mostra assunto, categoria e status. Vinte chamados por
 * página carregariam 100 KB de texto que nenhuma célula renderiza. Quem quer
 * o corpo abre o chamado, e aí `GET /support/tickets/:code` o traz.
 *
 * `id` e `accountId` também não saem: o código já identifica o chamado para
 * quem o lê e para a rota, e o uuid interno não tem uso do lado de fora.
 */
export function toSupportTicketOutput(
  ticket: SupportTicket,
): SupportTicketOutputDto {
  return {
    code: ticket.code,
    subject: ticket.subject,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    requesterName: ticket.authorName,
    assigneeName: ticket.operatorName,
    hasAttachment: ticket.hasAttachment,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    lastMessageAt: ticket.lastMessageAt,
    resolvedAt: ticket.resolvedAt,
  };
}

/**
 * URL gravada → URL de leitura assinada, montado pelo use case antes de
 * apresentar (`SupportAttachmentService.signReadUrls`).
 *
 * O apresentador é síncrono de propósito, e a assinatura é I/O. Receber o
 * mapa pronto mantém o apresentador puro e deixa a decisão do que assinar —
 * e o custo disso — num lugar só.
 */
export type SignedUrls = ReadonlyMap<string, string>;

const NO_SIGNED_URLS: SignedUrls = new Map();

export function toSupportTicketMessageOutput(
  message: SupportTicketMessage,
  signedUrls: SignedUrls = NO_SIGNED_URLS,
): SupportTicketMessageDto {
  return {
    id: message.id,
    kind: message.kind,
    authorName: message.authorName,
    body: message.body,
    attachment: message.attachment
      ? {
          filename: message.attachment.filename,
          // Nunca a URL crua: ela responde 403. Sem assinatura, sem link.
          url: signedUrls.get(message.attachment.url) ?? null,
        }
      : null,
    createdAt: message.createdAt,
  };
}

/**
 * O histórico, derivado dos fatos duráveis do próprio chamado.
 *
 * Ver `SupportTicketEventDto` para a razão de não haver tabela de eventos. Em
 * `OPEN` sai um evento só — que é a verdade: nada aconteceu além da abertura.
 */
function toTimeline(ticket: SupportTicket): SupportTicketEventDto[] {
  const timeline: SupportTicketEventDto[] = [
    {
      type: 'CREATED',
      at: ticket.createdAt,
      actorName: ticket.authorName,
      status: null,
    },
  ];

  /**
   * `statusChangedAt`, e não `updatedAt`.
   *
   * Enquanto nada além do status escrevia no chamado, os dois eram o mesmo
   * carimbo. Deixaram de ser no instante em que existiu conversa: uma
   * resposta move `updatedAt`, e o histórico passaria a dizer que o chamado
   * foi resolvido na hora da última mensagem. O carimbo próprio é o que
   * mantém a frase verdadeira.
   *
   * Nulo significa que o status nunca mudou desde a abertura, e aí não há
   * evento a mostrar — inclusive nos chamados anteriores à coluna, que a
   * migração deixou nulos de propósito.
   */
  if (ticket.statusChangedAt) {
    timeline.push({
      type: 'STATUS_CHANGED',
      at: ticket.statusChangedAt,
      // `null` quando ninguém está atribuído: a tela escreve "equipe de
      // suporte" em vez de inventar um nome.
      actorName: ticket.operatorName,
      status: ticket.status,
    });
  }

  return timeline;
}

export function toSupportTicketDetailOutput(
  ticket: SupportTicket,
  /**
   * Já filtradas por quem consultou o repositório — o parâmetro `kinds` de
   * `listByTicketId` é obrigatório justamente para a decisão não cair aqui.
   * O apresentador não reclassifica nada.
   */
  messages: SupportTicketMessage[],
  canReply: boolean,
  signedUrls: SignedUrls,
): SupportTicketDetailOutputDto {
  return {
    ...toSupportTicketOutput(ticket),
    requesterEmail: ticket.authorEmail,
    message: ticket.message,
    /**
     * Os quatro campos do anexo nascem e morrem juntos (ver a entidade), então
     * um `url` presente já garante o `filename`. O `?? ''` existe só para o
     * compilador, não para um caso real.
     */
    attachment: ticket.attachmentUrl
      ? {
          filename: ticket.attachmentFilename ?? '',
          // A URL gravada é a permanente de um bucket privado; servida crua,
          // responde 403 — era o link que aparecia na tela e não abria.
          url: signedUrls.get(ticket.attachmentUrl) ?? null,
        }
      : null,
    messages: messages.map((message) =>
      toSupportTicketMessageOutput(message, signedUrls),
    ),
    timeline: toTimeline(ticket),
    canReply,
  };
}

/**
 * A linha da fila do operador.
 *
 * Um apresentador separado, e não um campo a mais no do cliente: são públicos
 * diferentes, e o que os separa é justamente o que não pode vazar de um para
 * o outro. `requesterEmail` e `organizationName` são triagem para quem
 * atende e ruído para quem abriu o chamado; a conversa administrativa carrega
 * nota interna e a do cliente não pode. Um apresentador só, com flags,
 * transformaria essa fronteira num `if` que alguém inverte.
 */
export function toAdminSupportTicketOutput(
  ticket: SupportTicket,
  context: SupportOrganizationContext,
): AdminSupportTicketOutputDto {
  return {
    id: ticket.id,
    code: ticket.code,
    subject: ticket.subject,
    // Literal, não coluna — ver o DTO.
    channel: 'SUPPORT',
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    requesterName: ticket.authorName,
    requesterEmail: ticket.authorEmail,
    organizationId: ticket.organizationId,
    organizationName: context.name,
    planType: context.planType,
    assigneeId: ticket.operatorId,
    assigneeName: ticket.operatorName,
    hasAttachment: ticket.hasAttachment,
    createdAt: ticket.createdAt,
    lastMessageAt: ticket.lastMessageAt,
    resolvedAt: ticket.resolvedAt,
  };
}

export function toAdminSupportTicketDetailOutput(
  ticket: SupportTicket,
  context: SupportOrganizationContext,
  messages: SupportTicketMessage[],
  signedUrls: SignedUrls,
): AdminSupportTicketDetailOutputDto {
  return {
    ...toAdminSupportTicketOutput(ticket, context),
    message: ticket.message,
    attachmentUrl: ticket.attachmentUrl
      ? (signedUrls.get(ticket.attachmentUrl) ?? null)
      : null,
    attachmentFilename: ticket.attachmentFilename,
    messages: messages.map((message) =>
      toSupportTicketMessageOutput(message, signedUrls),
    ),
  };
}

/** Todas as URLs gravadas de um chamado e da conversa — o que há a assinar. */
export function attachmentUrlsOf(
  ticket: SupportTicket,
  messages: SupportTicketMessage[],
): (string | null)[] {
  return [
    ticket.attachmentUrl,
    ...messages.map((message) => message.attachment?.url ?? null),
  ];
}
