import type { Operator } from 'src/modules/auth/domain/entities';
import type { PageResult } from 'src/shared/domain/repositories/pagination';
import type { ObservedTicket } from '../entities';

/**
 * Um chamado como o `allva-api` o devolveu.
 *
 * `facts` é o recorte que o SLA usa; `payload` é a resposta inteira, que volta
 * para a tela intacta — o backoffice-api **enriquece** o chamado do produto,
 * não o redesenha. Um campo novo no produto aparece na fila sem mudança aqui.
 */
export type ProductSupportTicket = {
  facts: ObservedTicket;
  payload: Record<string, unknown>;
};

export type SupportQueueFilter = {
  search?: string;
  status?: string;
  priority?: string;
  category?: string;
  organizationId?: string;
  assignee?: string;
  page: number;
  pageSize: number;
};

/**
 * Os chamados vivem no `allva-api`. Toda chamada vai **em nome do operador**:
 * o produto aplica as próprias permissões, e o backoffice-api nunca age com
 * mais poder do que quem clicou.
 */
export abstract class SupportTicketsGatewayInterface {
  abstract list(
    operator: Operator,
    filter: SupportQueueFilter,
  ): Promise<PageResult<ProductSupportTicket>>;

  abstract get(
    operator: Operator,
    ticketId: string,
  ): Promise<ProductSupportTicket>;

  abstract assign(
    operator: Operator,
    ticketId: string,
    assigneeId: string | null,
  ): Promise<ProductSupportTicket>;
}
