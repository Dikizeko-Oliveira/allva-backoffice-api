import { Injectable } from '@nestjs/common';
import { SupportTicketsRepositoryInterface } from 'src/modules/support/domain/ports';
import { SupportCenterAccessService } from '../services/support-center-access.service';
import {
  ListSupportTicketsOutputDto,
  ListSupportTicketsQueryDto,
} from '../dtos';
import { toSupportTicketOutput } from '../support-ticket.presenter';

/**
 * `GET /api/v1/support/tickets` — a tela de chamados da Central de suporte.
 *
 * Escopo é organização, não conta: um chamado aberto por um analista é
 * assunto do time, e esconder dos colegas o que a equipe de suporte já
 * respondeu produziria dois chamados para o mesmo problema. Quem entra na
 * Central já passou pelo RBAC da organização.
 */
@Injectable()
export class ListSupportTicketsUseCase {
  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly access: SupportCenterAccessService,
  ) {}

  async execute(input: {
    query: ListSupportTicketsQueryDto;
    organizationId: string | null;
  }): Promise<ListSupportTicketsOutputDto> {
    const organizationId = await this.access.assert(
      input.organizationId,
      'support-dedicated-channel',
    );

    const result = await this.ticketsRepository.list({
      organizationId,
      status: input.query.status,
      category: input.query.category,
      priority: input.query.priority,
      search: input.query.search,
      page: input.query.page ?? 1,
      pageSize: input.query.pageSize ?? 20,
    });

    return {
      items: result.items.map(toSupportTicketOutput),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      countsByStatus: result.countsByStatus,
    };
  }
}
