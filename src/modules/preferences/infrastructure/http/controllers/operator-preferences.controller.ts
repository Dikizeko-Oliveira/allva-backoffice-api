import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  OperatorPreferenceOutputDto,
  UpdateOperatorPreferenceInputDto,
} from 'src/modules/preferences/application/dtos';
import {
  GetOperatorPreferenceUseCase,
  UpdateOperatorPreferenceUseCase,
} from 'src/modules/preferences/application/use-cases';

@ApiTags('Preferências do operador')
@ApiBearerAuth()
@Controller('/api/v1/me/preferences')
export class OperatorPreferencesController {
  constructor(
    private readonly getOperatorPreferenceUseCase: GetOperatorPreferenceUseCase,
    private readonly updateOperatorPreferenceUseCase: UpdateOperatorPreferenceUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Minhas preferências' })
  @ApiOkResponse({ type: OperatorPreferenceOutputDto })
  async get(
    @CurrentOperator() operator: Operator,
  ): Promise<OperatorPreferenceOutputDto> {
    return this.getOperatorPreferenceUseCase.execute(operator);
  }

  @Put()
  @ApiOperation({
    summary: 'Salvar minhas preferências',
    description: 'Substitui tudo: campo ausente volta ao default.',
  })
  @ApiOkResponse({ type: OperatorPreferenceOutputDto })
  async put(
    @CurrentOperator() operator: Operator,
    @Body() dto: UpdateOperatorPreferenceInputDto,
  ): Promise<OperatorPreferenceOutputDto> {
    return this.updateOperatorPreferenceUseCase.execute(operator, dto);
  }
}
