import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import { ApplyRecommendationDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { ApplyRecommendationPlanUseCase } from 'src/modules/platform-actions/application/use-cases/apply-recommendation-plan.usecase';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { ApiEnvelopeRawResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';

/**
 * `/recommendations/{id}/apply` — **rota de `recommendations`, controller de
 * `platform-actions`** (D3, rota ≠ módulo).
 *
 * O mesmo precedente de `POST /ads/{id}/actions` e de
 * `GET /ads/{id}/recommendations`, aplicado na direção contrária: lá o
 * controller desceu para quem escreve; aqui ele desceu porque aplicar **é**
 * escrever. `recommendations` continua sem conhecer `AdActionGateway`, e §16.4
 * continua verificável por teste.
 *
 * **A rota ganhou RBAC ao mudar de módulo**, e isso não é efeito colateral: até
 * A2-S8 ela era dry-run e nenhuma permissão fazia sentido; a partir do momento
 * em que ela move dinheiro, P5 exige a mesma cadeia de `POST /ads/{id}/actions`.
 */
@ApiTags('Recommendations')
@ApiBearerAuth('access-token')
@Controller('/api/v1/recommendations')
@UseGuards(EntitlementGuard, OrganizationAccessGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class RecommendationApplyController {
  constructor(
    private readonly applyPlan: ApplyRecommendationPlanUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  /**
   * `POST /recommendations/{id}/apply` — §9.5.
   *
   * **`actions:execute_sensitive`**, e não `actions:execute`. Um plano é uma
   * decisão que a Allva tomou e o usuário aceitou; ele pode conter ajuste de
   * orçamento e substituição de criativo na mesma chamada, e pedir a permissão
   * da ação mais fraca daria ao `ANALYST` a capacidade de disparar as
   * sensíveis pela porta que a máquina abriu. Mesma leitura do lote de A2-S8.
   *
   * Responde **200**: o corpo é o relatório por ação — cada uma com o `202`
   * dela ou a recusa que a impediu. Um `202` pelo conjunto prometeria uma
   * resposta única que não existe.
   */
  @Post('/:id/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('actions:execute_sensitive')
  @ApiOperation({
    summary: 'Revalidar a premissa e aplicar o plano',
    description:
      '`dryRun` ausente ou `true` devolve o plano e a linha de base do outcome, ' +
      'sem escrever. `dryRun: false` executa cada ação pelo caminho de escrita ' +
      'único, sujeito a PLATFORM_ACTIONS_DRY_RUN_ONLY e à cadeia de P5.',
  })
  @ApiEnvelopeRawResponse({
    description:
      '**200, e o corpo é o relatório por ação** — cada uma com o 202 dela ou ' +
      'a recusa que a impediu. Um 202 pelo conjunto prometeria uma resposta ' +
      'única que não existe. Exige `actions:execute_sensitive`: um plano pode ' +
      'conter ajuste de orçamento e substituição de criativo na mesma chamada.',
  })
  @ApiDomainError(
    409,
    'A premissa não vale mais, ou há conflito com outra recomendação no mesmo alvo. ' +
      'A revalidação de §9.5 roda **antes** de qualquer escrita, e a expiração é gravada na hora.',
    ['RECOMMENDATION_PREMISE_STALE', 'CONFLICTING_RECOMMENDATION'],
  )
  @ApiDomainError(
    422,
    'Conteúdo autoral de IA sem confirmação do dígito do texto (R14).',
    ['AI_CONTENT_CONFIRMATION_REQUIRED'],
  )
  async apply(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: ApplyRecommendationDto,
    @Req() request: Request,
  ) {
    return this.applyPlan.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      recommendationId: id,
      body,
      correlationId: request.header('x-correlation-id') ?? null,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para aplicar recomendações.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
