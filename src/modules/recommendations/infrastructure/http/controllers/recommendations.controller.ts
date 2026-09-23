import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import {
  DismissRecommendationDto,
  ListRecommendationsQueryDto,
} from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { DismissRecommendationUseCase } from 'src/modules/recommendations/application/use-cases/dismiss-recommendation.usecase';
import {
  GetImpactSummaryUseCase,
  GetRecommendationUseCase,
  ListRecommendationsUseCase,
  ListSuppressionsUseCase,
  RemoveSuppressionUseCase,
} from 'src/modules/recommendations/application/use-cases/recommendation-read-use-cases';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  ImpactSummaryDto,
  RecommendationDto,
  SuppressionDto,
} from 'src/modules/recommendations/application/dtos/responses/recommendation-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';

/**
 * A superfície de recomendações (§7.3, §9).
 *
 * **Nenhuma rota aqui escreve na plataforma, e agora isso é literal.**
 * `POST /{id}/apply` passou a mover dinheiro em A2-S9 e mudou de módulo junto —
 * o controller dela vive em `platform-actions`
 * ([recommendation-apply.controller.ts](../../../../platform-actions/infrastructure/http/controllers/recommendation-apply.controller.ts)),
 * pela mesma regra que trouxe `GET /ads/{id}/recommendations` para cá: **rota ≠
 * módulo** (D3). §16.4 continua verificável — nenhum módulo a montante importa
 * `AdActionGateway`.
 *
 * **`/impact-summary` nunca soma os três tipos.** `SAVINGS`, `EFFICIENCY_GAIN` e
 * `REVENUE_UPLIFT` têm confianças diferentes por natureza; somá-los produziria um
 * número de capa cuja maior parcela é a menos confiável.
 */
@ApiTags('Recommendations')
@ApiBearerAuth('access-token')
@Controller('/api/v1/recommendations')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class RecommendationsController {
  constructor(
    private readonly listRecommendations: ListRecommendationsUseCase,
    private readonly getRecommendation: GetRecommendationUseCase,
    private readonly getImpactSummary: GetImpactSummaryUseCase,
    private readonly listSuppressions: ListSuppressionsUseCase,
    private readonly removeSuppression: RemoveSuppressionUseCase,
    private readonly dismiss: DismissRecommendationUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar recomendações',
    description:
      'Cursor, `advisory` e `blocked`. Uma recomendação retida por guarda aparece ' +
      'com `blockedReason` visível — bloqueio não some em silêncio (§9.3).',
  })
  @ApiEnvelopeResponse(RecommendationDto, {
    isArray: true,
    description:
      'Cursor em `meta.page`. Cada item traz `actions[]` — o plano executável, ' +
      'não só o texto.',
  })
  @ApiDomainError(409, 'Motor de recomendação desligado nesta instalação.', [
    'RECOMMENDATION_ENGINE_DISABLED',
  ])
  async list(
    @CurrentUser() user: Account,
    @Query() query: ListRecommendationsQueryDto,
  ) {
    return this.listRecommendations.execute(
      await this.organizationOf(user),
      query,
    );
  }

  @Get('/impact-summary')
  @ApiOperation({
    summary: 'Impacto por tipo — três tipos separados, nunca somados',
    description:
      'Estimado e realizado na mesma unidade. O realizado vem de ' +
      '`RecommendationOutcome` por join (B8), e só existe depois de a janela pós fechar.',
  })
  @ApiEnvelopeResponse(ImpactSummaryDto, {
    description:
      '`measurement` distingue "zero" de "ainda não": uma organização sem ' +
      'nenhuma janela fechada tem realizado zero e não errou nada.',
  })
  async impactSummary(@CurrentUser() user: Account) {
    return this.getImpactSummary.execute(await this.organizationOf(user));
  }

  @Get('/suppressions')
  @ApiOperation({ summary: 'Listar supressões ativas' })
  @ApiEnvelopeResponse(SuppressionDto, { isArray: true })
  async suppressions(@CurrentUser() user: Account) {
    return this.listSuppressions.execute(await this.organizationOf(user));
  }

  @Delete('/suppressions/:id')
  @ApiOperation({ summary: 'Remover uma supressão' })
  @ApiEnvelopeResponse(SuppressionDto, {
    description: 'A supressão removida.',
  })
  async deleteSuppression(
    @CurrentUser() user: Account,
    @Param('id') id: string,
  ) {
    return this.removeSuppression.execute(await this.organizationOf(user), id);
  }

  @Get('/:id')
  @ApiOperation({ summary: 'Detalhar recomendação, com ações e evidência' })
  @ApiEnvelopeResponse(RecommendationDto)
  async detail(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getRecommendation.execute(await this.organizationOf(user), id);
  }

  /**
   * `POST /{id}/dismiss` — dispensar **cria uma supressão** (§9.4 passo 3d).
   *
   * As duas coisas juntas, sempre: marcar `DISMISSED` sem suprimir faria a
   * geração de amanhã reapresentar o mesmo plano, e o usuário concluiria — com
   * razão — que o produto não escuta.
   */
  @Post('/:id/dismiss')
  @ApiOperation({
    summary: 'Dispensar, criando supressão com escopo e prazo',
    description:
      '**Não existe `PATCH /recommendations/{id}/status`.** Dispensar é este ' +
      'endpoint (e cria supressão, senão a geração de amanhã reapresenta o ' +
      'mesmo plano); aplicar é `POST /recommendations/{id}/apply`, que mora em ' +
      '`platform-actions` porque escreve.',
  })
  @ApiEnvelopeResponse(RecommendationDto, {
    description: 'A recomendação em `DISMISSED`, com a supressão já criada.',
  })
  async dismissOne(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: DismissRecommendationDto,
  ) {
    return this.dismiss.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      id,
      body,
    });
  }

  /** Toda leitura é escopada pela organização (§16.7). */
  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para ver recomendações.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
