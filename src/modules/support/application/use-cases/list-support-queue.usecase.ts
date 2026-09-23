import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SupportTicketsGatewayInterface } from 'src/modules/support/domain/ports';
import { slaUrgencyOrder } from 'src/modules/support/domain/sla';
import { resolvePage } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { ListSupportQueueOutputDto, ListSupportQueueQueryDto } from '../dtos';
import { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';

/**
 * A fila do `allva-api`, com SLA. A paginação e os filtros são do produto; a
 * reordenação por risco acontece **dentro da página** — o produto não conhece
 * o SLA, então não há como ordenar o conjunto inteiro por ele.
 */
@Injectable()
export class ListSupportQueueUseCase {
  constructor(
    private readonly ticketsGateway: SupportTicketsGatewayInterface,
    private readonly slaTracker: TicketSlaTrackerService,
  ) {}

  async execute(
    operator: Operator,
    query: ListSupportQueueQueryDto,
  ): Promise<ListSupportQueueOutputDto> {
    assertPlatformPermission(operator, 'support:read');

    const page = await this.ticketsGateway.list(operator, {
      search: query.search,
      status: query.status,
      priority: query.priority,
      category: query.category,
      organizationId: query.organizationId,
      assignee: query.assignee,
      ...resolvePage(query),
    });

    const items = await this.slaTracker.track(page.items);

    // `sort` é estável: dentro do mesmo risco vale a ordem do produto.
    items.sort(
      (a, b) => slaUrgencyOrder(a.sla.state) - slaUrgencyOrder(b.sla.state),
    );

    return { ...page, items };
  }
}
