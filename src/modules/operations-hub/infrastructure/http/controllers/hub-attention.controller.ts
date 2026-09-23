import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import { OperatorAttentionOutputDto } from 'src/modules/operations-hub/application/dtos';
import { GetOperatorAttentionUseCase } from 'src/modules/operations-hub/application/use-cases';

/**
 * A metade interna do Operations Hub. A outra metade (faturas vencidas,
 * integrações com erro…) é `GET /api/v1/admin/attention` do `allva-api`; a web
 * junta as duas.
 */
@ApiTags('Operations Hub')
@ApiBearerAuth()
@Controller('/api/v1/hub')
export class HubAttentionController {
  constructor(
    private readonly getOperatorAttentionUseCase: GetOperatorAttentionUseCase,
  ) {}

  @Get('attention')
  @ApiOperation({
    summary:
      'Pendências do processo interno, filtradas pelas permissões do operador',
    description:
      'Qualquer operador. Só voltam os sinais cuja permissão ele tem; `count: null` é contagem indisponível, não zero.',
  })
  @ApiOkResponse({ type: OperatorAttentionOutputDto })
  async attention(
    @CurrentOperator() operator: Operator,
  ): Promise<OperatorAttentionOutputDto> {
    return this.getOperatorAttentionUseCase.execute(operator);
  }
}
