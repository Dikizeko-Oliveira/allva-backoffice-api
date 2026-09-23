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
import { ApplyWasteFixUseCase } from 'src/modules/platform-actions/application/use-cases/apply-waste-fix.usecase';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { ApiEnvelopeRawResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * `POST /waste/items/{id}/apply-fix` — §10.9, linha "por ação".
 *
 * **Terceiro caminho HTTP que não pertence ao módulo dono do dado** (D3).
 * `/waste/...` é a superfície de desperdício; o controller mora em
 * `platform-actions` porque **corrigir é escrever**, e `waste` não conhece quem
 * escreve — nem passará a conhecer.
 *
 * O verbo que `waste` continua tendo é `PATCH /waste/items/{id}/resolve`, que
 * resolve o **achado** e não toca plataforma nenhuma. A diferença entre os dois
 * é a diferença entre registrar que o problema acabou e fazer ele acabar.
 */
@ApiTags('Waste Detector')
@ApiBearerAuth('access-token')
@Controller('/api/v1/waste')
@UseGuards(EntitlementGuard, OrganizationAccessGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class WasteFixController {
  constructor(
    private readonly applyWasteFix: ApplyWasteFixUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  /**
   * **`actions:execute_sensitive`**, como o apply de recomendação: a rota não
   * declara qual ação vai executar — quem declara é o plano —, e pedir a
   * permissão da mais fraca daria acesso às sensíveis por uma porta lateral.
   *
   * **Resolve todos os itens vinculados**, e não só o clicado. A relação é N:N;
   * fechar um e deixar os outros abertos faria a tela continuar cobrando ação
   * sobre um anúncio que a ação acabou de corrigir. A resolução acontece no
   * passo 8 de §9.5, quando o plano assenta — fechá-los aqui os resolveria
   * antes de a plataforma responder.
   */
  @Post('/items/:id/apply-fix')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('actions:execute_sensitive')
  @ApiOperation({
    summary: 'Corrigir um achado executando a recomendação vinculada',
    description:
      'Traduz o achado na recomendação ativa e segue o mesmo caminho de ' +
      '`POST /recommendations/{id}/apply`. Achado sem recomendação ativa ' +
      'responde com o motivo e aponta a resolução manual.',
  })
  @ApiEnvelopeRawResponse({
    description:
      'Mesmo relatório de `POST /recommendations/{id}/apply`. Resolve **todos** ' +
      'os achados vinculados, não só o do caminho: fechar um e deixar os outros ' +
      'faria a tela continuar cobrando ação sobre um anúncio que a ação acabou ' +
      'de corrigir.',
  })
  async applyFix(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: ApplyRecommendationDto,
    @Req() request: Request,
  ) {
    return this.applyWasteFix.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      wasteItemId: id,
      dryRun: body.dryRun,
      confirmedContentDigests: body.confirmedContentDigests,
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
      message: 'Selecione uma organização para corrigir achados.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
