import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AlertEventOutputDto,
  ListAlertEventsOutputDto,
  ListAlertEventsQueryDto,
} from 'src/modules/alerts/application/dtos';
import {
  AcknowledgeAlertEventUseCase,
  ListAlertEventsUseCase,
} from 'src/modules/alerts/application/use-cases';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';

@ApiTags('Alertas')
@ApiBearerAuth()
@Controller('/api/v1/alerts')
export class AlertEventsController {
  constructor(
    private readonly listAlertEventsUseCase: ListAlertEventsUseCase,
    private readonly acknowledgeAlertEventUseCase: AcknowledgeAlertEventUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Alertas visíveis para o operador',
    description:
      'Só os disparos de regras cuja `requiredPermission` o operador tem.',
  })
  @ApiOkResponse({ type: ListAlertEventsOutputDto })
  async list(
    @CurrentOperator() operator: Operator,
    @Query() query: ListAlertEventsQueryDto,
  ): Promise<ListAlertEventsOutputDto> {
    return this.listAlertEventsUseCase.execute(operator, query);
  }

  @Post(':id/acknowledge')
  @ApiOperation({
    summary: 'Reconhecer alerta',
    description:
      'Exige a `requiredPermission` da regra. Idempotente: vale o primeiro reconhecimento.',
  })
  @ApiCreatedResponse({ type: AlertEventOutputDto })
  async acknowledge(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
  ): Promise<AlertEventOutputDto> {
    return this.acknowledgeAlertEventUseCase.execute(operator, id);
  }
}
