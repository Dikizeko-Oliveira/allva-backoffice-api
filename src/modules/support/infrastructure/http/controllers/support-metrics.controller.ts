import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  SupportMetricsOutputDto,
  SupportMetricsQueryDto,
} from 'src/modules/support/application/dtos';
import { GetSupportMetricsUseCase } from 'src/modules/support/application/use-cases';

@ApiTags('Suporte - Métricas')
@ApiBearerAuth()
@Controller('/api/v1/support/metrics')
export class SupportMetricsController {
  constructor(
    private readonly getSupportMetricsUseCase: GetSupportMetricsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Métricas de atendimento',
    description: 'Exige `support:read`.',
  })
  @ApiOkResponse({ type: SupportMetricsOutputDto })
  async metrics(
    @CurrentOperator() operator: Operator,
    @Query() query: SupportMetricsQueryDto,
  ): Promise<SupportMetricsOutputDto> {
    return this.getSupportMetricsUseCase.execute(operator, query);
  }
}
