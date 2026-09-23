import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ResolveWasteItemDto } from 'src/modules/waste/application/dtos/resolve-waste-item.dto';
import {
  ListWasteItemsQueryDto,
  WasteRollupQueryDto,
  WasteSummaryQueryDto,
} from 'src/modules/waste/application/dtos/waste-query.dto';
import {
  GetEvidenceSummaryUseCase,
  GetWasteItemUseCase,
  GetWasteRollupUseCase,
  GetWasteSummaryUseCase,
  ListWasteByAdUseCase,
  ListWasteItemsUseCase,
} from 'src/modules/waste/application/use-cases/waste-read-use-cases';
import { ResolveWasteItemUseCase } from 'src/modules/waste/application/use-cases/resolve-waste-item.usecase';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  EvidenceSummaryDto,
  WasteByAdRowDto,
  WasteItemDto,
  WasteRollupRowDto,
  WasteSummaryDto,
} from 'src/modules/waste/application/dtos/responses/waste-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';

/**
 * A superfície de desperdício (§7.3, §10.8).
 *
 * Três **ausências** definem este controller tanto quanto as rotas presentes:
 *
 * - **`GET /waste/impact` não voltou.** Impacto realizado passa a ser medido em
 *   `RecommendationOutcome` (A2-S9); mantê-la aqui prometeria um número que o v1
 *   nunca mediu de fato — ele somava estimativas e as chamava de economia.
 * - **Não há filtro `level`.** Com uma granularidade só de métrica ele não tem o
 *   que filtrar, e mantê-lo seria convite a reintroduzir a dupla contagem (G10).
 * - **Não há `openAmount`.** Toda rota devolve o **par** de grandezas (§10.1): o
 *   incorrido responde "quanto já queimei" e o evitável diário responde "quanto
 *   queimo por dia se não fizer nada". O segundo é o único comparável com o
 *   impacto medido depois — e o único sobre o qual ainda há o que fazer.
 */
@ApiTags('Waste Detector')
@ApiBearerAuth('access-token')
@Controller('/api/v1/waste')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class WasteController {
  constructor(
    private readonly getSummary: GetWasteSummaryUseCase,
    private readonly listItems: ListWasteItemsUseCase,
    private readonly getItem: GetWasteItemUseCase,
    private readonly listByAd: ListWasteByAdUseCase,
    private readonly getRollup: GetWasteRollupUseCase,
    private readonly resolveItem: ResolveWasteItemUseCase,
    private readonly getEvidence: GetEvidenceSummaryUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/summary')
  @ApiOperation({
    summary: 'Resumo do desperdício aberto',
    description:
      'Par de grandezas: incorrido (passado) e evitável por dia (futuro). Soma as ' +
      'denormalizações de `ads` — o máximo por anúncio —, nunca `waste_items`.',
  })
  @ApiEnvelopeResponse(WasteSummaryDto)
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async summary(
    @CurrentUser() user: Account,
    @Query() query: WasteSummaryQueryDto,
  ) {
    return this.getSummary.execute(await this.organizationOf(user), query);
  }

  @Get('/evidence')
  @ApiOperation({
    summary: 'O que a detecção ainda não pôde julgar',
    description:
      'O silêncio explicado (P7): quantos anúncios esperam evidência, por quê ' +
      '(dias, gasto, conversões, comparação, objetivo) e quando o primeiro deve ' +
      'poder ser julgado. Complementa `/summary`, que só conta o que foi encontrado.',
  })
  @ApiEnvelopeResponse(EvidenceSummaryDto)
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async evidence(
    @CurrentUser() user: Account,
    @Query() query: WasteSummaryQueryDto,
  ) {
    return this.getEvidence.execute(await this.organizationOf(user), query);
  }

  @Get('/items')
  @ApiOperation({
    summary: 'Listar achados',
    description:
      'Cursor, `findingKind` e `dataMaturity`. Ordenado pelo que dá para interromper hoje.',
  })
  @ApiEnvelopeResponse(WasteItemDto, {
    isArray: true,
    description: 'Cursor em `meta.page`. Padrão `state=open`.',
  })
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async items(
    @CurrentUser() user: Account,
    @Query() query: ListWasteItemsQueryDto,
  ) {
    return this.listItems.execute(await this.organizationOf(user), query);
  }

  /**
   * `/waste/opportunities` — a mesma máquina, o outro `findingKind` (§10.2).
   *
   * Rota separada em vez de um filtro por conveniência: um anúncio saudável
   * sufocado por orçamento é dinheiro que deixou de ser ganho, não gasto mal, e
   * pôr os dois na mesma lista é o primeiro passo para alguém somá-los.
   */
  @Get('/opportunities')
  @ApiOperation({
    summary: 'Listar oportunidades (nunca somadas ao desperdício)',
  })
  @ApiEnvelopeResponse(WasteItemDto, {
    isArray: true,
    description:
      'Mesmo shape de `/waste/items`, com `findingKind: OPPORTUNITY` fixo. ' +
      'Rota separada, e não filtro: pôr as duas famílias na mesma lista é o ' +
      'primeiro passo para alguém somá-las.',
  })
  async opportunities(
    @CurrentUser() user: Account,
    @Query() query: ListWasteItemsQueryDto,
  ) {
    return this.listItems.execute(await this.organizationOf(user), {
      ...query,
      findingKind: 'OPPORTUNITY',
    });
  }

  @Get('/by-ad')
  @ApiOperation({
    summary: 'Desperdício agregado por anúncio',
    description:
      'Uma linha por anúncio, com o máximo entre tipos (§10.6) — nunca a soma.',
  })
  @ApiEnvelopeResponse(WasteByAdRowDto, { isArray: true })
  async byAd(
    @CurrentUser() user: Account,
    @Query() query: ListWasteItemsQueryDto,
  ) {
    return this.listByAd.execute(await this.organizationOf(user), query);
  }

  @Get('/rollup')
  @ApiOperation({
    summary: 'Rollup por campanha, conjunto, plataforma ou conta',
    description:
      'Subconsulta pré-agregada por anúncio: um anúncio com três achados abertos ' +
      'contribui **uma vez**. A janela vigente é declarada em `meta.provenance` e ' +
      'não filtra o join (DEC-11).',
  })
  @ApiEnvelopeResponse(WasteRollupRowDto, {
    isArray: true,
    description:
      '`data` é a lista de grupos. A moeda-base vai em `meta.organization` e ' +
      '`excludedByWindowMismatch` em `meta.provenance` — não no corpo.',
  })
  async rollup(
    @CurrentUser() user: Account,
    @Query() query: WasteRollupQueryDto,
  ) {
    return this.getRollup.execute(await this.organizationOf(user), query);
  }

  @Get('/items/:id')
  @ApiOperation({ summary: 'Detalhe do achado, com evidência e procedência' })
  @ApiEnvelopeResponse(WasteItemDto)
  async item(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getItem.execute(await this.organizationOf(user), id);
  }

  /**
   * `PATCH /waste/items/{id}/resolve` (§10.9).
   *
   * O único verbo de escrita da superfície de desperdício, e ele não toca
   * plataforma nenhuma: resolve o **achado**, não o anúncio. Pausar o anúncio é
   * ação, pertence a `platform-actions` e chega em A2-S7.
   */
  @Patch('/items/:id/resolve')
  @ApiOperation({
    summary: 'Resolver ou dispensar um achado, com motivo',
    description:
      '**`PATCH`, não `POST`.** Resolve o **achado**, não o anúncio — nenhuma ' +
      'plataforma é tocada aqui. Para corrigir de verdade, ' +
      '`POST /waste/items/{id}/apply-fix`, que escreve.',
  })
  @ApiEnvelopeResponse(WasteItemDto, { description: 'O achado já resolvido.' })
  @ApiDomainError(409, 'Detector desligado, ou achado já resolvido.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async resolve(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: ResolveWasteItemDto,
  ) {
    return this.resolveItem.execute({
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
      message: 'Selecione uma organização para ver o desperdício.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
