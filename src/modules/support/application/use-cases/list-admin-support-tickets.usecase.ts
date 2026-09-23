import { Injectable } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  SupportOrganizationContextPortInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import {
  ListAdminSupportTicketsOutputDto,
  ListAdminSupportTicketsQueryDto,
} from '../dtos';
import { toAdminSupportTicketOutput } from '../support-ticket.presenter';

/**
 * `GET /api/v1/admin/support/tickets` — a fila do painel de operador.
 *
 * **Cross-org**, e é essa a razão de não reusar `ListSupportTicketsUseCase`:
 * aquele exige `organizationId` do contexto autenticado e recusa sem ele;
 * este atende a base inteira e aceita a organização como *filtro*. Acrescentar
 * um parâmetro opcional lá apagaria a garantia que o lado do cliente tem hoje
 * — a de que nenhuma consulta sai sem escopo.
 *
 * A autorização mora aqui, no use case, via `PlatformRoleService` — mesmo
 * lugar de `admin-sales-leads` e `admin-contracts`, e é o que garante que um
 * segundo chamador (um job, outra porta HTTP) não escape dela. Exige
 * `support:read`: suporte e administração, conforme a matriz em
 * `accounts/domain/platform-rbac.ts`.
 */
@Injectable()
export class ListAdminSupportTicketsUseCase {
  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly organizationContext: SupportOrganizationContextPortInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminSupportTicketsQueryDto,
    actorId: string,
  ): Promise<ListAdminSupportTicketsOutputDto> {
    await this.platformRole.assertPermission(actorId, 'support:read');

    const result = await this.ticketsRepository.listForOperator({
      search: query.search,
      status: query.status,
      priority: query.priority,
      category: query.category,
      organizationId: query.organizationId,
      assignee: query.assignee,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });

    // Uma consulta para a página inteira — ver o port.
    const contexts = await this.organizationContext.resolveMany(
      result.items.map((ticket) => ticket.organizationId),
    );

    return {
      items: result.items.map((ticket) =>
        toAdminSupportTicketOutput(
          ticket,
          contexts.get(ticket.organizationId) ?? {
            name: null,
            planType: null,
          },
        ),
      ),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      countsByStatus: result.countsByStatus,
    };
  }
}
