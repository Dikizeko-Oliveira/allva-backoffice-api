import { randomUUID } from 'crypto';
import type { SupportTicketAttachment } from './support-ticket.entity';

export const SupportTicketMessageKindValues = [
  'CUSTOMER',
  'OPERATOR',
  'INTERNAL_NOTE',
] as const;

export type SupportTicketMessageKind =
  (typeof SupportTicketMessageKindValues)[number];

/**
 * O que o cliente pode ver da conversa.
 *
 * Constante exportada, e não um `filter` escrito em cada apresentador: é a
 * regra que separa a nota interna do resto, e ela vale em toda rota de
 * cliente — presente e futura. Uma cópia por rota é como a terceira esqueceria.
 */
export const CUSTOMER_VISIBLE_MESSAGE_KINDS: readonly SupportTicketMessageKind[] =
  ['CUSTOMER', 'OPERATOR'];

export function isCustomerVisible(kind: SupportTicketMessageKind): boolean {
  return CUSTOMER_VISIBLE_MESSAGE_KINDS.includes(kind);
}

type CreateSupportTicketMessageProps = {
  ticketId: string;
  kind: SupportTicketMessageKind;
  authorId: string | null;
  authorName: string;
  body: string;
  /** Os quatro campos juntos, ou nenhum — mesma regra do anexo do chamado. */
  attachment?: SupportTicketAttachment | null;
};

type RestoreSupportTicketMessageProps = CreateSupportTicketMessageProps & {
  id: string;
  createdAt: Date;
};

export class SupportTicketMessage {
  private _id: string;
  private _ticketId: string;
  private _kind: SupportTicketMessageKind;
  private _authorId: string | null;
  private _authorName: string;
  private _body: string;
  private _attachment: SupportTicketAttachment | null;
  private _createdAt: Date;

  private constructor(props: RestoreSupportTicketMessageProps) {
    this._id = props.id;
    this._ticketId = props.ticketId;
    this._kind = props.kind;
    this._authorId = props.authorId;
    this._authorName = props.authorName;
    this._body = props.body;
    this._attachment = props.attachment ?? null;
    this._createdAt = props.createdAt;
  }

  static create(
    props: CreateSupportTicketMessageProps,
    now: Date = new Date(),
  ): SupportTicketMessage {
    return new SupportTicketMessage({
      ...props,
      id: randomUUID(),
      createdAt: now,
    });
  }

  static restore(
    props: RestoreSupportTicketMessageProps,
  ): SupportTicketMessage {
    return new SupportTicketMessage(props);
  }

  get id() {
    return this._id;
  }

  get ticketId() {
    return this._ticketId;
  }

  get kind() {
    return this._kind;
  }

  get authorId() {
    return this._authorId;
  }

  get authorName() {
    return this._authorName;
  }

  get body() {
    return this._body;
  }

  get attachment() {
    return this._attachment;
  }

  get createdAt() {
    return this._createdAt;
  }

  get isCustomerVisible(): boolean {
    return isCustomerVisible(this._kind);
  }

  toJSON() {
    return {
      id: this._id,
      ticketId: this._ticketId,
      kind: this._kind,
      authorId: this._authorId,
      authorName: this._authorName,
      body: this._body,
      attachmentUrl: this._attachment?.url ?? null,
      attachmentFilename: this._attachment?.filename ?? null,
      createdAt: this._createdAt,
    };
  }
}
