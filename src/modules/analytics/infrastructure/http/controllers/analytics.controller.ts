import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { AnalyticsQueryDto } from '../../../application/dtos/analytics-query.dto';
import { GetAnalyticsOverviewUseCase } from '../../../application/use-cases/get-analytics-overview.usecase';
import { GetPlatformHealthUseCase } from '../../../application/use-cases/get-platform-health.usecase';
import { GetCrossChannelUseCase } from '../../../application/use-cases/get-cross-channel.usecase';
import { GetBudgetAllocationUseCase } from '../../../application/use-cases/get-budget-allocation.usecase';
import { GetBudgetPacingUseCase } from '../../../application/use-cases/get-budget-pacing.usecase';
import { GetCoverageUseCase } from '../../../application/use-cases/get-coverage.usecase';
import { GetDailyDigestUseCase } from '../../../application/use-cases/get-daily-digest.usecase';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import {
  AnalyticsOverviewDto,
  BudgetAllocationDto,
  BudgetPacingDto,
  CoverageDto,
  CrossChannelDto,
  PlatformHealthDto,
} from 'src/modules/analytics/application/dtos/responses/analytics-response.dto';
import {
  ApiEnvelopeRawResponse,
  ApiEnvelopeResponse,
} from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * Analytics **envelopado** a partir de A2-S5 (§7.0.1, P7).
 *
 * As quatro rotas devolvem número derivado e passam a carregar `asOf` e
 * `provenance` — sai da lista de controllers legados do harness, que só encolhe.
 * A mudança é de contrato: o corpo antigo vira `data`, e é o preço de o rollup
 * de desperdício aqui declarar de onde vem, agora que ele vem da view
 * `open_waste` em vez de uma agregação própria.
 */
@ApiTags('Analytics')
@ApiBearerAuth('access-token')
@Controller('/api/v1/analytics')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AnalyticsController {
  constructor(
    private readonly overviewUseCase: GetAnalyticsOverviewUseCase,
    private readonly platformHealthUseCase: GetPlatformHealthUseCase,
    private readonly crossChannelUseCase: GetCrossChannelUseCase,
    private readonly budgetAllocationUseCase: GetBudgetAllocationUseCase,
    private readonly budgetPacingUseCase: GetBudgetPacingUseCase,
    private readonly dailyDigestUseCase: GetDailyDigestUseCase,
    private readonly coverageUseCase: GetCoverageUseCase,
  ) {}

  @Get('/overview')
  @ApiOperation({ summary: 'Visão geral consolidada (spend, ROAS, deltas)' })
  @ApiEnvelopeResponse(AnalyticsOverviewDto, {
    description:
      'Os deltas comparam com o período anterior de mesmo tamanho. ' +
      '`totals.currency` declara a unidade — sem ela, um agregado de contas em ' +
      'moedas diferentes não é dinheiro em moeda nenhuma.',
  })
  async overview(
    @CurrentUser() user: Account,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.overviewUseCase.execute(user.id, query);
  }

  @Get('/platform-health')
  @ApiOperation({ summary: 'Saúde por plataforma (STRONG/OK/WEAK + sinais)' })
  @ApiEnvelopeResponse(PlatformHealthDto, {
    description:
      '`signals[]` traz o que produziu o veredito: o rótulo sozinho manda o ' +
      'usuário procurar o que já sabemos.',
  })
  async platformHealth(
    @CurrentUser() user: Account,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.platformHealthUseCase.execute(user.id, query);
  }

  @Get('/cross-channel')
  @ApiOperation({
    summary: 'Análise cruzada com divisão de receita configurável',
  })
  @ApiEnvelopeResponse(CrossChannelDto, {
    description:
      '`attributedRevenue` é redistribuição declarada de receita observada, ' +
      '**não** atribuição causal.',
  })
  async crossChannel(
    @CurrentUser() user: Account,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.crossChannelUseCase.execute(user.id, query);
  }

  @Get('/budget-allocation')
  @ApiOperation({
    summary: 'Recomendação de realocação de orçamento por canal',
  })
  @ApiEnvelopeResponse(BudgetAllocationDto, {
    description:
      'Realocação **entre canais**, no nível da conta — não confundir com ' +
      '`/recommendations`, que propõe ação executável sobre um anúncio.',
  })
  async budgetAllocation(
    @CurrentUser() user: Account,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.budgetAllocationUseCase.execute(user.id, query);
  }

  @Get('/budget-pacing')
  @ApiOperation({
    summary: 'Ritmo de consumo do orçamento',
    description:
      'Compara o gasto com o que a régua do orçamento previa para os dias já ' +
      'decorridos. A projeção é extrapolação linear declarada, não previsão — e ' +
      'o que não pôde entrar é contado, nunca ignorado.',
  })
  @ApiEnvelopeResponse(BudgetPacingDto, {
    description:
      '`data` é `null` em workspace pessoal, que por construção não tem ' +
      'anúncio — zeros ali afirmariam que não se gasta nada.',
  })
  async budgetPacing(
    @CurrentUser() user: Account,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.budgetPacingUseCase.execute(user.id, query);
  }

  @Get('/coverage')
  @ApiOperation({
    summary: 'Campanhas ativas que a Allva não analisa',
    description:
      'Cobertura declarada (P7): campanha ativa sem nenhum anúncio que o sync ' +
      'consiga ler. O gasto dela fica fora de score, detecção e recomendação, ' +
      'e também dos totais, que vêm da série por anúncio.',
  })
  @ApiEnvelopeResponse(CoverageDto, {
    description: '`data` é `null` em workspace pessoal.',
  })
  async coverage(@CurrentUser() user: Account) {
    return this.coverageUseCase.execute(user.id);
  }

  @Get('/daily-digest')
  @ApiOperation({
    summary: 'Resumo diário da organização',
    description:
      '**Só lê.** O texto é produzido uma vez por dia pelo agendador; esta rota ' +
      'nunca aciona a IA — um resumo gerado na leitura entraria em ação a cada ' +
      'refresh. Sem resumo do dia, `data` vem `null` e a tela diz que ainda não ' +
      'há. `enrichedByAI: false` significa que o texto é o determinístico (P4), ' +
      'não que o resumo falhou.',
  })
  @ApiEnvelopeRawResponse({
    description:
      '`{ digestDate, facts, narrative, enrichedByAI, reusedFromDate }`, ou ' +
      '`null` quando ainda não há resumo. `meta.asOf` é o dia do resumo, não o ' +
      'instante da resposta — o texto pode ser de ontem.',
  })
  async dailyDigest(@CurrentUser() user: Account) {
    return this.dailyDigestUseCase.execute(user.id);
  }
}
