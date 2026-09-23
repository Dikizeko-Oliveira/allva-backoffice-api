import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ResolveAdWasteDto } from 'src/modules/waste/application/dtos/resolve-waste-item.dto';
import { ResolveAdWasteUseCase } from 'src/modules/waste/application/use-cases/resolve-ad-waste.usecase';
import {
  GetAdEvidenceUseCase,
  GetAdWasteUseCase,
} from 'src/modules/waste/application/use-cases/waste-read-use-cases';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  AdEvidenceDto,
  WasteItemDto,
} from 'src/modules/waste/application/dtos/responses/waste-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';

/**
 * `GET /ads/{id}/waste` — **rota de `ads`, controller de `waste`** (D3).
 *
 * §5.3 r.10 lista esta rota sob o módulo `ads`, e escrevê-la lá é impossível:
 * `ads` é a base do grafo (r.1) e não pode importar `waste`, nem por port de
 * leitura, porque `waste` já importa `ads` e o ciclo apareceria na montagem do
 * Nest, não em `tsc`. É a mesma impossibilidade lógica que D2 encontrou para
 * `AdScoreView` — e a mesma resolução: **rota ≠ módulo**.
 *
 * A alternativa seria inverter a dependência com um port declarado em `ads` e
 * implementado em `waste`, como r.8 faz para credenciais. Ela não serve aqui:
 * o provider teria de estar no injetor de `AdsModule`, o que exige `AdsModule`
 * importar `WasteModule` — o ciclo de volta, agora disfarçado de inversão.
 */
@ApiTags('Ads')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AdWasteController {
  constructor(
    private readonly getAdWaste: GetAdWasteUseCase,
    private readonly resolveAdWaste: ResolveAdWasteUseCase,
    private readonly getAdEvidence: GetAdEvidenceUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/:id/waste')
  @ApiOperation({
    summary: 'Achados de desperdício abertos de um anúncio',
    description:
      'Lista vazia significa "olhamos e não encontramos". "Ainda não olhamos" ' +
      'aparece como `staleObservation` nos itens que sobraram da última leitura válida.',
  })
  @ApiEnvelopeResponse(WasteItemDto, { isArray: true })
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async waste(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getAdWaste.execute(await this.organizationOf(user), id);
  }

  @Get('/:id/evidence')
  @ApiOperation({
    summary: 'O que a detecção não pôde julgar neste anúncio',
    description:
      'Para que o anúncio foi otimizado, e cada motivo pelo qual algum detector ' +
      'não o julgou — com o que falta e a estimativa de quando deve chegar. ' +
      'Complementa `/waste`: lá fica o que foi encontrado; aqui, o que não deu para olhar.',
  })
  @ApiEnvelopeResponse(AdEvidenceDto)
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async evidence(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getAdEvidence.execute(await this.organizationOf(user), id);
  }

  /**
   * `POST /ads/{id}/resolve` — §5.3 r.10 atribui esta rota a `waste`, e é o
   * único `POST` do módulo.
   *
   * **Não toca plataforma nenhuma.** Resolve os *achados*; pausar o anúncio é
   * ação, pertence a `platform-actions` e chega em A2-S7. P1 continua valendo:
   * a Allva não origina nem altera mídia por aqui.
   */
  @Post('/:id/resolve')
  @ApiOperation({
    summary: 'Resolver os achados abertos de um anúncio',
    description:
      'Sem `types`, resolve todos os abertos. Com `types`, só os informados — ' +
      'quem trocou o criativo resolveu a fadiga, não o CPA alto.',
  })
  @ApiEnvelopeResponse(WasteItemDto, {
    isArray: true,
    description:
      'Os achados resolvidos. **Nenhuma plataforma é tocada** — para pausar o ' +
      'anúncio, `POST /ads/{id}/actions`.',
  })
  @ApiDomainError(409, 'Detector desligado nesta instalação.', [
    'WASTE_DETECTOR_DISABLED',
  ])
  async resolve(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: ResolveAdWasteDto,
  ) {
    return this.resolveAdWaste.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      adId: id,
      body,
    });
  }

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
