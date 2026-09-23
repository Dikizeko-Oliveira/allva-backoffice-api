import { Injectable } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import type { ObservedTicket } from 'src/modules/support/domain/entities';
import {
  ProductSupportTicket,
  SupportQueueFilter,
  SupportTicketsGatewayInterface,
} from 'src/modules/support/domain/ports';
import type { PageResult } from 'src/shared/domain/repositories/pagination';
import { AllvaApiClient } from 'src/shared/infrastructure/allva-api/allva-api.client';

/** O recorte de `AdminSupportTicketOutputDto` (allva-api) que o SLA lê. */
type ApiSupportTicket = {
  id: string;
  status: string;
  priority: string;
  category?: string | null;
  assigneeId?: string | null;
  createdAt: string;
  lastMessageAt: string;
  resolvedAt?: string | null;
  messages?: { kind: string; createdAt: string }[];
  [key: string]: unknown;
};

type ApiPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

const ADMIN_TICKETS_PATH = '/api/v1/admin/support/tickets';

/** `GET/PATCH /api/v1/admin/support/tickets` do `allva-api`. */
@Injectable()
export class AllvaApiSupportTicketsGateway extends SupportTicketsGatewayInterface {
  constructor(private readonly allvaApi: AllvaApiClient) {
    super();
  }

  async list(
    operator: Operator,
    filter: SupportQueueFilter,
  ): Promise<PageResult<ProductSupportTicket>> {
    const page = await this.allvaApi.request<ApiPage<ApiSupportTicket>>(
      ADMIN_TICKETS_PATH,
      { token: operator.accessToken, query: { ...filter } },
    );

    return { ...page, items: page.items.map(toProductTicket) };
  }

  async get(
    operator: Operator,
    ticketId: string,
  ): Promise<ProductSupportTicket> {
    const ticket = await this.allvaApi.request<ApiSupportTicket>(
      ticketPath(ticketId),
      { token: operator.accessToken },
    );

    return toProductTicket(ticket);
  }

  async assign(
    operator: Operator,
    ticketId: string,
    assigneeId: string | null,
  ): Promise<ProductSupportTicket> {
    const ticket = await this.allvaApi.request<ApiSupportTicket>(
      ticketPath(ticketId),
      {
        method: 'PATCH',
        token: operator.accessToken,
        body: { assigneeId },
      },
    );

    return toProductTicket(ticket);
  }
}

function ticketPath(ticketId: string): string {
  return `${ADMIN_TICKETS_PATH}/${encodeURIComponent(ticketId)}`;
}

function toProductTicket(ticket: ApiSupportTicket): ProductSupportTicket {
  const facts: ObservedTicket = {
    id: ticket.id,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category ?? null,
    assigneeId: ticket.assigneeId ?? null,
    createdAt: new Date(ticket.createdAt),
    lastMessageAt: new Date(ticket.lastMessageAt),
    resolvedAt: ticket.resolvedAt ? new Date(ticket.resolvedAt) : null,
    // A listagem do produto não traz mensagens; só o detalhe traz.
    messages: Array.isArray(ticket.messages)
      ? ticket.messages.map((message) => ({
          kind: message.kind,
          createdAt: new Date(message.createdAt),
        }))
      : null,
  };

  return { facts, payload: ticket };
}
