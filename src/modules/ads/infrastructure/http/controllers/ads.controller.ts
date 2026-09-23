import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import {
  AdAnalysisDto,
  AdDetailDto,
  AdHistoryEntryDto,
  AdListItemDto,
  AdSnapshotDto,
} from 'src/modules/ads/application/dtos/responses/ad-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ListAdsQueryDto } from 'src/modules/ads/application/dtos/list-ads-query.dto';
import {
  GetAdAnalysisUseCase,
  GetAdHistoryUseCase,
  GetAdSeriesUseCase,
  GetAdUseCase,
  ListAdsUseCase,
} from 'src/modules/ads/application/use-cases/ad-read-use-cases';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * A superfície de **leitura** do agregado `Ad` (§7.1).
 *
 * **Rota ≠ módulo** (D3). O prefixo `/ads` é compartilhado, a propriedade não:
 * `POST /ads/{id}/actions` pertencerá a `platform-actions`, `POST /ads/{id}/sync`
 * a `sync`, `POST /ads/{id}/analyze` a `creative-lab` e `POST /ads/{id}/resolve`
 * a `waste`. Sem essa regra, o prefixo comum convida `ads` a importar
 * `platform-actions` — e a base do grafo passa a depender da ponta.
 *
 * **Nenhum verbo de escrita aqui, por ausência de handler.** Não há `POST` nem
 * `PATCH` neste arquivo, e é isso que P1 verifica: a Allva não origina mídia.
 */
@ApiTags('Ads')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AdsController {
  constructor(
    private readonly listAds: ListAdsUseCase,
    private readonly getAd: GetAdUseCase,
    private readonly getSeries: GetAdSeriesUseCase,
    private readonly getHistory: GetAdHistoryUseCase,
    private readonly getAnalysis: GetAdAnalysisUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar anúncios',
    description:
      'Cursor, 16 filtros e 5 ordenações. Padrão `sortBy=avoidableDaily` — rankeia pelo que dá ' +
      'para interromper hoje. Quem está abaixo do piso de confiança de §12.4 não entra na ' +
      'ordenação, e `meta.evidenceSufficiency` declara que houve exclusão.',
  })
  @ApiEnvelopeResponse(AdListItemDto, {
    isArray: true,
    description:
      'Pagina por cursor em `meta.page` — `nextCursor` é opaco, repasse como ' +
      '`cursor=`. `meta.coverageByPlatform` traz o teto de cobertura de cada ' +
      'plataforma presente na página, sem o qual 0,45 no Search e 0,45 na Meta ' +
      'pareceriam a mesma coisa.',
  })
  @ApiDomainError(
    409,
    'Superfície ads-first desligada nesta instalação (`PRECONDITION_FAILED`).',
    ['ADS_FIRST_READ_DISABLED'],
  )
  async list(@CurrentUser() user: Account, @Query() query: ListAdsQueryDto) {
    return this.listAds.execute(await this.organizationOf(user), query);
  }

  @Get('/:id')
  @ApiOperation({ summary: 'Detalhar anúncio, com linhagem' })
  @ApiEnvelopeResponse(AdDetailDto)
  @ApiDomainError(409, 'Superfície ads-first desligada.', [
    'ADS_FIRST_READ_DISABLED',
  ])
  async detail(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getAd.execute(await this.organizationOf(user), id);
  }

  @Get('/:id/analysis')
  @ApiOperation({
    summary: 'Análise do anúncio — estado por seção, sempre 200',
    description:
      'Seção sem dado devolve `PENDING`/`UNAVAILABLE` com motivo. É o contrato definitivo: ' +
      'lista vazia diria "não há problema", que é uma afirmação diferente de "ainda não analisamos".',
  })
  @ApiEnvelopeResponse(AdAnalysisDto, {
    description:
      'Sempre 200 quando o anúncio existe. Seção sem dado traz `status` e ' +
      '`reason` — nunca 404, nunca lista vazia.',
  })
  async analysis(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getAnalysis.execute(await this.organizationOf(user), id);
  }

  @Get('/:id/metrics')
  @ApiOperation({ summary: 'Série diária do anúncio' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  @ApiQuery({
    name: 'followLineage',
    required: false,
    type: Boolean,
    description:
      'Padrão true — a série atravessa recriações do anúncio (§3.6).',
  })
  @ApiEnvelopeResponse(AdSnapshotDto, {
    isArray: true,
    description:
      'Linha com `normalizationPending: true` tem `valueBase` estimado e fica ' +
      'fora das agregações de inteligência (M1).',
  })
  async metrics(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query('days') days?: string,
    @Query('followLineage') followLineage?: string,
  ) {
    return this.getSeries.execute(await this.organizationOf(user), id, {
      days: days ? Number(days) : undefined,
      followLineage: followLineage !== 'false',
    });
  }

  @Get('/:id/history')
  @ApiOperation({ summary: 'Linha do tempo do anúncio (segue a linhagem)' })
  @ApiQuery({ name: 'followLineage', required: false, type: Boolean })
  @ApiEnvelopeResponse(AdHistoryEntryDto, { isArray: true })
  async history(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query('followLineage') followLineage?: string,
  ) {
    return this.getHistory.execute(
      await this.organizationOf(user),
      id,
      followLineage !== 'false',
    );
  }

  /**
   * As três seções cujo motor chega depois. Existem como rota desde já porque o
   * cliente precisa do caminho estável — e devolvem o motivo, não vazio.
   */
  @Get('/:id/scores')
  @ApiOperation({
    summary: 'Série de AI Score por linhagem',
    description:
      '**Não servida hoje: responde 422 em todos os casos.** O caminho de ' +
      'leitura existe (`AdScoreReader.seriesByLineage`) e não tem chamador; ' +
      'esta rota nunca foi ligada a ele. Não integre contra ela — a série de ' +
      'score que a tela precisa está em `GET /ads/{id}` (corrente) e em ' +
      '`GET /ads/{id}/analysis` (seção `score`).',
  })
  @ApiDomainError(
    422,
    'Sempre. A rota existe para o caminho ser estável, não porque serve dado.',
    ['SCORE_ENGINE_PENDING'],
  )
  scores(@Param('id') _id: string): never {
    throw new DomainError({
      code: 'SCORE_ENGINE_PENDING',
      category: 'INSUFFICIENT_EVIDENCE',
      message: 'O AI Score ainda não é calculado nesta instalação.',
      remediation:
        'A série existe assim que o ciclo diário de scoring pontuar este anúncio.',
    });
  }

  /**
   * `GET /:id/waste` **saiu daqui em A2-S5** e `GET /:id/recommendations` saiu
   * em A2-S7, pela mesma razão: são a resolução de uma impossibilidade, não uma
   * mudança de gosto.
   *
   * §5.3 r.10 lista as duas rotas sob `ads`, mas `ads` é a base do grafo (r.1) e
   * não pode importar `waste` nem `recommendations`; e a inversão — port
   * declarado aqui, implementado lá — exigiria `AdsModule` importar o outro
   * módulo para registrar o provider, que é o ciclo de volta com outro nome. Os
   * controllers moram nos donos do dado, os caminhos HTTP não mudaram, e é D3
   * aplicado: **rota ≠ módulo**. `POST /:id/actions` nasce sob a mesma regra.
   */

  /**
   * Toda leitura é escopada pela organização (§16.7). Workspace pessoal não tem
   * anúncio: a coluna é NOT NULL, e `ads` só existe sob organização.
   */
  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para ver anúncios.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
