import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { SUBSCRIPTIONS_PAGE_ALLOWED } from 'src/modules/subscriptions/access/domain/access-policy';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { UpgradeSummaryDto } from 'src/modules/paywall/application/dtos/upgrade-summary.dto';
import { GetUpgradeSummaryUseCase } from 'src/modules/paywall/application/get-upgrade-summary.usecase';

@ApiTags('Acesso e Entitlement')
@ApiBearerAuth()
@Controller('/api/v1/me')
@UseGuards(EntitlementGuard)
export class UpgradeSummaryController {
  constructor(private readonly getSummary: GetUpgradeSummaryUseCase) {}

  /**
   * Deliberadamente **fora** de `ALLOWED`.
   *
   * `SUBSCRIPTIONS_PAGE_ALLOWED` é o conjunto de estados em que o usuário está
   * na tela de contratação — e é exatamente onde esta rota serve. Quem já tem
   * acesso ao produto não precisa dela: tem `/waste/summary` inteiro, com filtro,
   * procedência e o par de grandezas completo.
   */
  @Get('upgrade-summary')
  @RequireAccessStatuses(...SUBSCRIPTIONS_PAGE_ALLOWED)
  @ApiOperation({
    summary: 'O que a Allva encontrou, para a tela de contratação',
    description:
      'Os números do próprio cliente, legíveis **enquanto o acesso ao produto ' +
      'está bloqueado** — que é quando a tela de contratação roda e quando ' +
      '`/waste/summary` responde 403. Nunca falha: fonte indisponível vira ' +
      '`state: "NO_DATA"`, não erro, porque um paywall que quebra é uma venda ' +
      'perdida.',
  })
  @ApiOkResponse({ type: UpgradeSummaryDto })
  async upgradeSummary(
    @CurrentUser() user: Account,
  ): Promise<UpgradeSummaryDto> {
    return this.getSummary.execute(user.id);
  }
}
