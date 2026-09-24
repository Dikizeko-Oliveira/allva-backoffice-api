import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  ProductSupportTicket,
  SupportQueueFilter,
  SupportTicketsGatewayInterface,
} from 'src/modules/support/domain/ports';
import { slaUrgencyOrder } from 'src/modules/support/domain/sla';
import {
  offsetOf,
  PageParams,
} from 'src/shared/domain/repositories/pagination';
import {
  PAGE_MAX_SIZE,
  resolvePage,
} from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { ListSupportQueueOutputDto, ListSupportQueueQueryDto } from '../dtos';
import { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';

/**
 * Teto de chamados varridos ao filtrar por `sla`. O produto pagina no máximo
 * `PAGE_MAX_SIZE` por chamada, então este teto é sempre um múltiplo dele —
 * cinco chamadas para o `allva-api` na pior hipótese.
 *
 * Mais que suficiente para o volume real de hoje. Quando a base crescer a
 * ponto de este teto cortar chamados de verdade, o filtro por SLA precisa
 * parar de varrer o produto a cada requisição e passar a consultar o
 * `ticket_sla_snapshots` do próprio backoffice-api — o que só é correto depois
 * que o polling periódico de `GET /api/v1/admin/support/tickets` existir (ainda
 * não existe; `docs/backoffice-api.md` §4.1 o descreve como pré-requisito).
 * Sem ele, a tabela só tem os chamados que alguém já abriu na fila, e filtrar
 * por ela esconderia um chamado estourado que ninguém olhou ainda.
 */
const MAX_TICKETS_SCANNED_FOR_SLA_FILTER = 5 * PAGE_MAX_SIZE;

/**
 * A fila do `allva-api`, com SLA.
 *
 * ## Sem `sla`: a paginação é do produto
 *
 * Filtros e página vão direto para o `allva-api`; o SLA só reordena **dentro**
 * da página que voltou — o produto não conhece o conceito, então não há como
 * ordenar o conjunto inteiro por ele sem buscá-lo inteiro.
 *
 * ## Com `sla`: a paginação passa a ser daqui
 *
 * `sla` filtra por um estado que só o backoffice-api calcula, e que muda com o
 * relógio — não dá para pedir ao produto "só os estourados". A única forma
 * honesta é buscar todo o conjunto que casa os outros filtros (até o teto
 * abaixo), calcular o SLA de cada um e só então filtrar e paginar. `total`
 * aqui é exato sobre o que foi varrido, não uma estimativa.
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

    const baseFilter = {
      search: query.search,
      status: query.status,
      priority: query.priority,
      category: query.category,
      organizationId: query.organizationId,
      assignee: query.assignee,
    };

    if (!query.sla) {
      return this.listSinglePage(operator, baseFilter, resolvePage(query));
    }

    return this.listFilteredBySla(
      operator,
      baseFilter,
      query.sla,
      resolvePage(query),
    );
  }

  private async listSinglePage(
    operator: Operator,
    baseFilter: Omit<SupportQueueFilter, 'page' | 'pageSize'>,
    page: PageParams,
  ): Promise<ListSupportQueueOutputDto> {
    const result = await this.ticketsGateway.list(operator, {
      ...baseFilter,
      ...page,
    });

    const items = await this.slaTracker.track(result.items);

    // `sort` é estável: dentro do mesmo risco vale a ordem do produto.
    items.sort(
      (a, b) => slaUrgencyOrder(a.sla.state) - slaUrgencyOrder(b.sla.state),
    );

    return { ...result, items };
  }

  private async listFilteredBySla(
    operator: Operator,
    baseFilter: Omit<SupportQueueFilter, 'page' | 'pageSize'>,
    sla: NonNullable<ListSupportQueueQueryDto['sla']>,
    page: PageParams,
  ): Promise<ListSupportQueueOutputDto> {
    const scanned = await this.scanUpToLimit(operator, baseFilter);
    const tracked = await this.slaTracker.track(scanned);

    const matching = tracked.filter((ticket) => ticket.sla.state === sla);

    // Todos no mesmo estado: a urgência dentro dele é o próprio prazo. Nulo
    // (sem prazo pendente) vai para o fim — só acontece em `ON_TRACK`.
    matching.sort((a, b) => {
      const dueA = a.sla.nextDueAt ? new Date(a.sla.nextDueAt).getTime() : null;
      const dueB = b.sla.nextDueAt ? new Date(b.sla.nextDueAt).getTime() : null;
      if (dueA === null) return dueB === null ? 0 : 1;
      if (dueB === null) return -1;
      return dueA - dueB;
    });

    return {
      items: matching.slice(offsetOf(page), offsetOf(page) + page.pageSize),
      total: matching.length,
      ...page,
    };
  }

  /**
   * Todos os chamados que casam `baseFilter`, até `MAX_TICKETS_SCANNED_FOR_SLA_FILTER`.
   * Para de pedir mais páginas assim que o produto devolve menos do que pediu
   * — sinal de que chegou ao fim, mesmo que `total` diga outra coisa.
   */
  private async scanUpToLimit(
    operator: Operator,
    baseFilter: Omit<SupportQueueFilter, 'page' | 'pageSize'>,
  ): Promise<ProductSupportTicket[]> {
    const scanned: ProductSupportTicket[] = [];

    for (
      let page = 1;
      scanned.length < MAX_TICKETS_SCANNED_FOR_SLA_FILTER;
      page += 1
    ) {
      const result = await this.ticketsGateway.list(operator, {
        ...baseFilter,
        page,
        pageSize: PAGE_MAX_SIZE,
      });

      scanned.push(...result.items);

      if (
        result.items.length < PAGE_MAX_SIZE ||
        scanned.length >= result.total
      ) {
        break;
      }
    }

    return scanned;
  }
}
