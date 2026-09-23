import { Injectable } from '@nestjs/common';
import { ListSalesLeadsOutputDto, ListSalesLeadsQueryDto } from '../dtos';
import { SalesLeadsRepositoryInterface } from '../../domain/ports';
import { SalesLeadStatus } from '../../domain/entities';
import { toSalesLeadOutput } from '../sales-lead.presenter';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';

@Injectable()
export class ListSalesLeadsUseCase {
  constructor(
    private readonly salesLeadsRepository: SalesLeadsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  /**
   * O pipeline comercial inteiro — e por isso só para quem opera a plataforma.
   *
   * A rota exigia apenas sessão válida, então qualquer cliente logado listava
   * nome, e-mail corporativo, telefone, empresa e estágio de negociação de todos
   * os leads. Base comercial de um lado, dado pessoal de terceiros do outro.
   */
  async execute(
    query: ListSalesLeadsQueryDto,
    actorId: string,
  ): Promise<ListSalesLeadsOutputDto> {
    await this.platformRole.assertPermission(actorId, 'leads:read');

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const result = await this.salesLeadsRepository.list({
      status: query.status as SalesLeadStatus | undefined,
      assignedTo: query.assignedTo,
      q: query.q,
      source: query.source,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      page,
      pageSize,
    });

    return {
      items: result.items.map(toSalesLeadOutput),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
