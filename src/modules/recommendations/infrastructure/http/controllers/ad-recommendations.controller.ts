import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ListRecommendationsQueryDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { ListRecommendationsUseCase } from 'src/modules/recommendations/application/use-cases/recommendation-read-use-cases';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { RecommendationDto } from 'src/modules/recommendations/application/dtos/responses/recommendation-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * `GET /ads/{id}/recommendations` — **rota de `ads`, controller de
 * `recommendations`** (D3).
 *
 * A dívida que A2-S6 declarou. `ads` é a base do grafo (§5.3 r.1) e não pode
 * importar `recommendations`; a inversão por port exigiria `AdsModule` importar
 * `RecommendationsModule` para registrar o provider, que é o ciclo de volta com
 * outro nome. A resolução é a mesma que `GET /ads/{id}/waste` usa desde A2-S5:
 * **o caminho HTTP pertence ao produto, o controller pertence ao dono do dado.**
 *
 * É também o precedente que A2-S7 herda pronto: `POST /ads/{id}/actions` e
 * `GET /ads/{id}/actions/available` nascem em `platform-actions` sob
 * `@Controller('/api/v1/ads')`, sem que `ads` conheça nenhum dos dois.
 *
 * **Nada aqui é caso de uso novo.** A listagem já filtra por anúncio; esta rota
 * é a mesma leitura com o filtro vindo do caminho. Duplicá-la produziria dois
 * lugares onde "recomendações deste anúncio" pode divergir — cursor, ordenação
 * e piso de confiança inclusos.
 */
@ApiTags('Ads')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AdRecommendationsController {
  constructor(
    private readonly listRecommendations: ListRecommendationsUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/:id/recommendations')
  @ApiOperation({
    summary: 'Recomendações de um anúncio',
    description:
      'Mesma leitura de `GET /recommendations`, com o anúncio fixado pelo ' +
      'caminho. Aceita os demais filtros — `status`, `kind`, `advisory`, ' +
      '`blocked` — e o mesmo cursor.',
  })
  @ApiEnvelopeResponse(RecommendationDto, { isArray: true })
  async recommendations(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query() query: ListRecommendationsQueryDto,
  ) {
    /**
     * O caminho vence a query string. Sem isto,
     * `GET /ads/A/recommendations?adId=B` responderia sobre B numa URL que diz
     * A — a resposta seria correta para o repositório e mentirosa para quem a
     * leu.
     */
    return this.listRecommendations.execute(await this.organizationOf(user), {
      ...query,
      adId: id,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para ver as recomendações.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
