import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AlertRuleOutputDto,
  CreateAlertRuleInputDto,
  UpdateAlertRuleInputDto,
} from 'src/modules/alerts/application/dtos';
import {
  CreateAlertRuleUseCase,
  ListAlertRulesUseCase,
  UpdateAlertRuleUseCase,
} from 'src/modules/alerts/application/use-cases';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';

@ApiTags('Alertas - Regras')
@ApiBearerAuth()
@Controller('/api/v1/alert-rules')
export class AlertRulesController {
  constructor(
    private readonly listAlertRulesUseCase: ListAlertRulesUseCase,
    private readonly createAlertRuleUseCase: CreateAlertRuleUseCase,
    private readonly updateAlertRuleUseCase: UpdateAlertRuleUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar regras de alerta',
    description: 'Exige `settings:read`.',
  })
  @ApiOkResponse({ type: [AlertRuleOutputDto] })
  async list(
    @CurrentOperator() operator: Operator,
  ): Promise<AlertRuleOutputDto[]> {
    return this.listAlertRulesUseCase.execute(operator);
  }

  @Post()
  @ApiOperation({
    summary: 'Criar regra de alerta',
    description: 'Exige `settings:manage`.',
  })
  @ApiCreatedResponse({ type: AlertRuleOutputDto })
  async create(
    @CurrentOperator() operator: Operator,
    @Body() dto: CreateAlertRuleInputDto,
  ): Promise<AlertRuleOutputDto> {
    return this.createAlertRuleUseCase.execute(operator, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Alterar regra de alerta',
    description: 'Exige `settings:manage`.',
  })
  @ApiOkResponse({ type: AlertRuleOutputDto })
  async update(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
    @Body() dto: UpdateAlertRuleInputDto,
  ): Promise<AlertRuleOutputDto> {
    return this.updateAlertRuleUseCase.execute(operator, id, dto);
  }
}
