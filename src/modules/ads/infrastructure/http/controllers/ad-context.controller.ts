import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  PLATFORM_VALUES,
  type Platform,
} from 'src/modules/integrations/domain/entities/platform';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ListAdsQueryDto } from 'src/modules/ads/application/dtos/list-ads-query.dto';
import { ListAdsUseCase } from 'src/modules/ads/application/use-cases/ad-read-use-cases';
import {
  AdSetContextDto,
  CampaignContextDto,
  CreativeContextDto,
} from 'src/modules/ads/application/dtos/responses/ad-context-response.dto';
import { AdListItemDto } from 'src/modules/ads/application/dtos/responses/ad-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { AdContextRepositoryInterface } from 'src/modules/ads/domain/ports/ad-context.repository';
import { ResponseEnvelope } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Contexto: campanhas e conjuntos (§7.4).
 *
 * **Read-only, e não por convenção: por ausência de handler.** Não há `POST`,
 * `PATCH` nem `DELETE` neste arquivo. As rotas do v1 — `POST /campaigns`,
 * `DELETE /campaigns/{id}`, `POST /campaigns/ai/generate-*` e
 * `GET /campaigns/{id}/logs` — foram removidas em A2-S1 por violarem P1: a
 * Allva não origina mídia, e criar campanha localmente era originar uma que só
 * existia aqui.
 *
 * Sem envelope de inteligência: campanha e conjunto **não derivam número**. Eles
 * situam o anúncio; quem diagnostica é `/ads`. Marcá-los como rota de
 * inteligência os obrigaria a declarar procedência de um cálculo que não fazem.
 */
@ApiTags('Contexto de mídia')
@ApiBearerAuth('access-token')
@Controller('/api/v1')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@ResponseEnvelope()
export class AdContextController {
  constructor(
    private readonly context: AdContextRepositoryInterface,
    private readonly listAds: ListAdsUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/campaigns')
  @ApiOperation({ summary: 'Listar campanhas (contexto, read-only)' })
  @ApiEnvelopeResponse(CampaignContextDto, {
    isArray: true,
    description:
      'Pagina por `page`/`limit`, não por cursor: a ordenação é estável. ' +
      'Nenhum número de desempenho — contexto situa, não diagnostica.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'adAccountId', required: false, type: String })
  async listCampaigns(
    @CurrentUser() user: Account,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('adAccountId') adAccountId?: string,
  ) {
    const result = await this.context.listCampaigns({
      organizationId: await this.organizationOf(user),
      adAccountId,
      ...this.paging(page, limit),
    });

    return envelope(result.items, { asOf: new Date().toISOString() });
  }

  @Get('/campaigns/:id')
  @ApiOperation({ summary: 'Detalhar campanha' })
  @ApiEnvelopeResponse(CampaignContextDto)
  async getCampaign(@CurrentUser() user: Account, @Param('id') id: string) {
    const campaign = await this.context.findCampaign(
      await this.organizationOf(user),
      id,
    );

    if (!campaign) throw this.notFound('Campanha');
    return envelope(campaign, { asOf: new Date().toISOString() });
  }

  /**
   * Os anúncios da campanha delegam para `GET /ads` com o filtro aplicado: uma
   * segunda implementação da mesma listagem divergiria na primeira mudança de
   * filtro, e é a de `/ads` que carrega os pisos de confiança.
   */
  @Get('/campaigns/:id/ads')
  @ApiOperation({ summary: 'Anúncios da campanha' })
  @ApiEnvelopeResponse(AdListItemDto, {
    isArray: true,
    description:
      'Mesma resposta de `GET /ads`, com o filtro de campanha aplicado — não ' +
      'uma segunda implementação da listagem, que divergiria na primeira ' +
      'mudança de filtro.',
  })
  async campaignAds(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query() query: ListAdsQueryDto,
  ) {
    return this.listAds.execute(await this.organizationOf(user), {
      ...query,
      campaignId: id,
    });
  }

  @Get('/ad-sets')
  @ApiOperation({
    summary: 'Listar conjuntos de anúncios (contexto, read-only)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'campaignId', required: false, type: String })
  @ApiEnvelopeResponse(AdSetContextDto, { isArray: true })
  async listAdSets(
    @CurrentUser() user: Account,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('campaignId') campaignId?: string,
  ) {
    const result = await this.context.listAdSets({
      organizationId: await this.organizationOf(user),
      campaignId,
      ...this.paging(page, limit),
    });

    return envelope(result.items, { asOf: new Date().toISOString() });
  }

  @Get('/ad-sets/:id')
  @ApiOperation({ summary: 'Detalhar conjunto de anúncios' })
  @ApiEnvelopeResponse(AdSetContextDto)
  async getAdSet(@CurrentUser() user: Account, @Param('id') id: string) {
    const adSet = await this.context.findAdSet(
      await this.organizationOf(user),
      id,
    );

    if (!adSet) throw this.notFound('Conjunto de anúncios');
    return envelope(adSet, { asOf: new Date().toISOString() });
  }

  @Get('/ad-sets/:id/ads')
  @ApiOperation({ summary: 'Anúncios do conjunto' })
  @ApiEnvelopeResponse(AdListItemDto, { isArray: true })
  async adSetAds(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query() query: ListAdsQueryDto,
  ) {
    return this.listAds.execute(await this.organizationOf(user), {
      ...query,
      adSetId: id,
    });
  }

  /**
   * §7.4 — criativos como contexto (A2-S9).
   *
   * A rota estava parqueada desde A2-S1 com "volta em A2-S4", e A2-S4 entregou
   * as regras de §11 **sem** restaurá-la: a unidade de análise virou o par
   * `(Creative, Ad)`, e um endpoint indexado por criativo não devolve os cinco
   * desempenhos que o mesmo criativo tem em cinco anúncios.
   *
   * O que faltava era contexto, e é isso que ela é agora — no mesmo espírito de
   * `/campaigns` e `/ad-sets`: **situa, não diagnostica**. Quem quer diagnóstico
   * chama `POST /ads/{id}/analyze`, que responde sobre o par.
   *
   * O prefixo `/creatives` continua sendo de `creative-lab`, que mantém as
   * rotas de upload declaradas fora de escopo (D7.1). **Rota ≠ módulo** (D3), e
   * aqui os dois módulos dividem o prefixo — cada um com o que é seu.
   */
  @Get('/creatives')
  @ApiOperation({
    summary: 'Listar criativos sincronizados (contexto, read-only)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'campaignId', required: false, type: String })
  @ApiQuery({ name: 'adAccountId', required: false, type: String })
  @ApiQuery({ name: 'platform', required: false, enum: PLATFORM_VALUES })
  @ApiEnvelopeResponse(CreativeContextDto, {
    isArray: true,
    description:
      '**Nenhum número de desempenho, e a ausência é o contrato.** O mesmo ' +
      'criativo em cinco anúncios tem cinco desempenhos; a média descreveria ' +
      'um anúncio que não existe. Use `GET /creatives/{id}/ads`. ' +
      'Pagina por `page`/`limit`, e `meta.page.total` diz quantos existem.',
  })
  async listCreatives(
    @CurrentUser() user: Account,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('campaignId') campaignId?: string,
    @Query('adAccountId') adAccountId?: string,
    @Query('platform') platform?: string,
  ) {
    const paging = this.paging(page, limit);

    const result = await this.context.listCreatives({
      organizationId: await this.organizationOf(user),
      campaignId,
      adAccountId,
      platform: this.platformOf(platform),
      ...paging,
    });

    /*
      O `total` já era calculado pelo repositório e morria aqui: a rota
      paginava sem dizer que paginava, e o cliente não tinha como saber se
      havia página seguinte - o jeito era pedir `limit=100` e torcer.
    */
    return envelope(result.items, {
      asOf: new Date().toISOString(),
      page: {
        total: result.total,
        hasMore: paging.page * paging.limit < result.total,
      },
    });
  }

  @Get('/creatives/:id')
  @ApiOperation({ summary: 'Detalhar criativo sincronizado' })
  @ApiEnvelopeResponse(CreativeContextDto)
  async getCreative(@CurrentUser() user: Account, @Param('id') id: string) {
    const creative = await this.context.findCreative(
      await this.organizationOf(user),
      id,
    );

    if (!creative) throw this.notFound('Criativo');
    return envelope(creative, { asOf: new Date().toISOString() });
  }

  /**
   * Os anúncios em que este criativo roda — a rota que torna o par visível.
   *
   * É a resposta honesta para "como este criativo está indo?": **cada anúncio
   * com o número dele**, em vez de uma média que não descreve nenhum (§3.4).
   */
  @Get('/creatives/:id/ads')
  @ApiOperation({ summary: 'Anúncios que rodam este criativo' })
  @ApiEnvelopeResponse(AdListItemDto, {
    isArray: true,
    description:
      'É aqui que os N desempenhos do mesmo criativo aparecem — cada anúncio ' +
      'com o número dele, em vez de uma média que não descreve nenhum.',
  })
  async creativeAds(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Query() query: ListAdsQueryDto,
  ) {
    return this.listAds.execute(await this.organizationOf(user), {
      ...query,
      creativeId: id,
    });
  }

  private paging(page?: string, limit?: string) {
    return {
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT)),
    };
  }

  /**
   * `platform` fora do conjunto vira **sem filtro**, não erro.
   *
   * É a mesma leniência de `paging`, que corrige `page=0` em vez de recusar:
   * são filtros de uma listagem read-only, e a origem deles é um seletor de
   * conjunto fechado. Recusar a requisição inteira por um valor que a tela não
   * tem como produzir troca uma lista por uma tela de erro.
   */
  private platformOf(value?: string): Platform | undefined {
    return PLATFORM_VALUES.includes(value as Platform)
      ? (value as Platform)
      : undefined;
  }

  /**
   * **404, e não 400** — corrigido em A2-S9.
   *
   * A redação de A2-S2 usava `category: 'VALIDATION'`, que §7.0.4 mapeia para
   * `400`. Um recurso inexistente devolvia "requisição inválida", e o cliente
   * não tinha como distinguir "você mandou errado" de "isto não existe" — as
   * duas pedem telas opostas: corrigir o pedido, ou parar de pedir.
   *
   * As 13 categorias de §7.0.4 **não têm** `NOT_FOUND`, e é deliberado: ausência
   * de recurso não é erro de domínio, é ausência. O resto da aplicação usa
   * `NotFoundException` do Nest, e esta era a única superfície fora do padrão.
   *
   * Vale para `/campaigns/{id}` e `/ad-sets/{id}` também, que herdavam o mesmo
   * helper — mudança de contrato declarada, não efeito colateral.
   */
  private notFound(what: string): NotFoundException {
    return new NotFoundException(`${what} não encontrado nesta organização.`);
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para ver o contexto de mídia.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
