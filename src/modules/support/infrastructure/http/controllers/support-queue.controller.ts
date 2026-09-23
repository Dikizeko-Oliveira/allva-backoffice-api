import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  AssignSupportTicketInputDto,
  ListSupportQueueOutputDto,
  ListSupportQueueQueryDto,
  SupportTicketOutputDto,
} from 'src/modules/support/application/dtos';
import {
  AssignSupportTicketUseCase,
  GetSupportTicketUseCase,
  ListSupportQueueUseCase,
} from 'src/modules/support/application/use-cases';

/**
 * A fila de atendimento: os chamados do `allva-api` enriquecidos com SLA,
 * risco e escalonamento. O chamado continua sendo do produto — daqui só sai
 * processo interno.
 */
@ApiTags('Suporte - Fila')
@ApiBearerAuth()
@Controller('/api/v1/support')
export class SupportQueueController {
  constructor(
    private readonly listSupportQueueUseCase: ListSupportQueueUseCase,
    private readonly getSupportTicketUseCase: GetSupportTicketUseCase,
    private readonly assignSupportTicketUseCase: AssignSupportTicketUseCase,
  ) {}

  @Get('queue')
  @ApiOperation({
    summary: 'Fila de chamados com SLA',
    description:
      'Exige `support:read`. Filtros e paginação são repassados ao `allva-api`.',
  })
  @ApiOkResponse({ type: ListSupportQueueOutputDto })
  async queue(
    @CurrentOperator() operator: Operator,
    @Query() query: ListSupportQueueQueryDto,
  ): Promise<ListSupportQueueOutputDto> {
    return this.listSupportQueueUseCase.execute(operator, query);
  }

  @Get('tickets/:ticketId')
  @ApiOperation({
    summary: 'Chamado com SLA',
    description: 'Exige `support:read`.',
  })
  @ApiOkResponse({ type: SupportTicketOutputDto })
  async ticket(
    @CurrentOperator() operator: Operator,
    @Param('ticketId') ticketId: string,
  ): Promise<SupportTicketOutputDto> {
    return this.getSupportTicketUseCase.execute(operator, ticketId);
  }

  @Post('tickets/:ticketId/assignment')
  @ApiOperation({
    summary: 'Atribuir ou repassar um chamado',
    description:
      'Exige `support:manage`. Repassar um chamado que já tinha responsável exige `reason` (`400 ASSIGNMENT_REASON_REQUIRED`).',
  })
  @ApiCreatedResponse({ type: SupportTicketOutputDto })
  async assign(
    @CurrentOperator() operator: Operator,
    @Param('ticketId') ticketId: string,
    @Body() dto: AssignSupportTicketInputDto,
    @Req() request: Request,
  ): Promise<SupportTicketOutputDto> {
    return this.assignSupportTicketUseCase.execute(operator, ticketId, dto, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
