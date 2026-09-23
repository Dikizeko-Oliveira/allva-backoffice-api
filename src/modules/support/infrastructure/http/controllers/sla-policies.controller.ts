import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  CreateSlaPolicyInputDto,
  SlaPolicyOutputDto,
  UpdateSlaPolicyInputDto,
} from 'src/modules/support/application/dtos';
import {
  CreateSlaPolicyUseCase,
  ListSlaPoliciesUseCase,
  UpdateSlaPolicyUseCase,
} from 'src/modules/support/application/use-cases';

@ApiTags('Suporte - Políticas de SLA')
@ApiBearerAuth()
@Controller('/api/v1/support/sla-policies')
export class SlaPoliciesController {
  constructor(
    private readonly listSlaPoliciesUseCase: ListSlaPoliciesUseCase,
    private readonly createSlaPolicyUseCase: CreateSlaPolicyUseCase,
    private readonly updateSlaPolicyUseCase: UpdateSlaPolicyUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar políticas de SLA',
    description: 'Exige `support:read`.',
  })
  @ApiOkResponse({ type: [SlaPolicyOutputDto] })
  async list(
    @CurrentOperator() operator: Operator,
  ): Promise<SlaPolicyOutputDto[]> {
    return this.listSlaPoliciesUseCase.execute(operator);
  }

  @Post()
  @ApiOperation({
    summary: 'Criar política de SLA',
    description:
      'Exige `settings:manage`. Uma política ativa por prioridade + categoria (`409 SLA_POLICY_SCOPE_TAKEN`).',
  })
  @ApiCreatedResponse({ type: SlaPolicyOutputDto })
  async create(
    @CurrentOperator() operator: Operator,
    @Body() dto: CreateSlaPolicyInputDto,
  ): Promise<SlaPolicyOutputDto> {
    return this.createSlaPolicyUseCase.execute(operator, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Alterar política de SLA',
    description: 'Exige `settings:manage`.',
  })
  @ApiOkResponse({ type: SlaPolicyOutputDto })
  async update(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
    @Body() dto: UpdateSlaPolicyInputDto,
  ): Promise<SlaPolicyOutputDto> {
    return this.updateSlaPolicyUseCase.execute(operator, id, dto);
  }
}
