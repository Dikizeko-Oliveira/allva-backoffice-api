import { Injectable } from '@nestjs/common';
import { AlertEventsRepositoryInterface } from 'src/modules/alerts/domain/ports';
import type { Operator } from 'src/modules/auth/domain/entities';
import { resolvePage } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { toAlertEventOutput } from '../alerts.presenter';
import { ListAlertEventsOutputDto, ListAlertEventsQueryDto } from '../dtos';

/**
 * Qualquer operador lista alertas — mas só os das regras cuja permissão ele
 * tem. O recorte é a própria lista de permissões do operador: não há rota que
 * devolva alerta de outra área, nem zerado.
 */
@Injectable()
export class ListAlertEventsUseCase {
  constructor(
    private readonly eventsRepository: AlertEventsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: ListAlertEventsQueryDto,
  ): Promise<ListAlertEventsOutputDto> {
    const result = await this.eventsRepository.list(
      {
        permissions: operator.permissions,
        acknowledged:
          query.acknowledged === undefined
            ? undefined
            : query.acknowledged === 'true',
      },
      resolvePage(query),
    );

    return { ...result, items: result.items.map(toAlertEventOutput) };
  }
}
