import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { AnalyzeAdUseCase } from 'src/modules/creative-lab/application/use-cases/analyze-ad.usecase';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { AdAnalysisResultDto } from 'src/modules/creative-lab/application/dtos/responses/ad-analysis-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * `POST /ads/{id}/analyze` — **rota de `ads`, controller de `creative-lab`** (D3).
 *
 * Anunciada em A2-S2 (`ads` não depende de ninguém) e entregue em A2-S9, junto
 * da remoção da rota que ela substitui. É o mesmo padrão de
 * `GET /ads/{id}/waste` e `POST /ads/{id}/actions`: o caminho HTTP pertence ao
 * produto, o controller pertence ao dono do dado.
 *
 * **`POST`, e não `GET`, mesmo sem escrever na plataforma.** A análise cria uma
 * versão nova de `CreativeAnalysis` — é escrita de domínio, e um `GET` que
 * gravasse linha a cada chamada quebraria a expectativa de idempotência que todo
 * cliente HTTP tem. Não é ação sobre mídia: P1 continua valendo, e nada aqui
 * cria entidade na plataforma.
 */
@ApiTags('Ads')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AdAnalysisController {
  constructor(
    private readonly analyze: AnalyzeAdUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Post('/:id/analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Analisar o par (Creative, Ad)',
    description:
      'Comparação entre anúncios do mesmo criativo com dispersão robusta ' +
      '(IQR/MAD) e candidatos de substituição. **Sem veredito abaixo de três ' +
      'anúncios comparáveis** — a comparação aparece sem conclusão, que é ' +
      'diferente de não aparecer.',
  })
  @ApiEnvelopeResponse(AdAnalysisResultDto, {
    description:
      '**A sucessora de `POST /creatives/{id}/optimize`**, que foi removida e ' +
      'não renomeada: a unidade de análise é o par `(Creative, Ad)`, e um ' +
      'endpoint indexado por criativo não devolve os N desempenhos que o mesmo ' +
      'criativo tem em N anúncios. `reusedPreviousAnalysis: true` significa que ' +
      'o digest não mudou e nada foi recalculado (P9) — não é cache de HTTP.',
  })
  async analyzeAd(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.analyze.execute({
      organizationId: await this.organizationOf(user),
      adId: id,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para analisar anúncios.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
