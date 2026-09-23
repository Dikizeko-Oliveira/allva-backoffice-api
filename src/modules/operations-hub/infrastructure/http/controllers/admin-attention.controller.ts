import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OperatorAttentionOutputDto } from 'src/modules/operations-hub/application/dtos';
import { GetOperatorAttentionUseCase } from 'src/modules/operations-hub/application/use-cases';

/**
 * O Operations Hub, sob `/admin`. Mesmo desenho das outras superfícies
 * administrativas: autorização no use case, sem `EntitlementGuard` — operador
 * não tem assinatura.
 *
 * A identidade e as permissões do operador **não** estão aqui: continuam em
 * `GET /api/v1/auth/me` (`platformRole`, `platformPermissions`), que é a fonte
 * única da navegação. Esta rota só responde "o que espera por mim".
 */
@ApiTags('Admin - Operations Hub')
@ApiBearerAuth()
@Controller('/api/v1/admin/attention')
export class AdminAttentionController {
  constructor(
    private readonly getOperatorAttentionUseCase: GetOperatorAttentionUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'O que espera pela ação do operador, filtrado pelo papel dele',
    description:
      'Qualquer papel de plataforma; conta de cliente recebe 403 `ACCOUNT_NOT_AUTHORIZED`. ' +
      'Devolve só os sinais cuja permissão o operador tem — sinal de outra área não aparece nem zerado. ' +
      '`count: null` indica contagem indisponível no momento, não zero.',
  })
  @ApiOkResponse({ type: OperatorAttentionOutputDto })
  async attention(
    @CurrentUser() user: Account,
  ): Promise<OperatorAttentionOutputDto> {
    return this.getOperatorAttentionUseCase.execute(user.id);
  }
}
