import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import {
  QuarantineItemDto,
  RebindResultDto,
  SyncBatchAcceptedDto,
} from 'src/modules/sync/application/dtos/responses/sync-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { ListQuarantineUseCase } from 'src/modules/sync/application/use-cases/list-quarantine.usecase';
import { RebindIntegrationUseCase } from 'src/modules/sync/application/use-cases/rebind-integration.usecase';
import { SyncAdsBatchUseCase } from 'src/modules/sync/application/use-cases/sync-ads-batch.usecase';
import { SyncAdsBatchDto } from 'src/modules/sync/application/dtos/sync-ads-batch.dto';
import { RebindIntegrationDto } from 'src/modules/sync/application/dtos/rebind-integration.dto';

/**
 * A superfície do módulo `sync`.
 *
 * **Rota ≠ módulo** (D3): `POST /ads/sync-batch` mora no prefixo de `ads`, mas
 * pertence a `sync` — quem lê a plataforma é quem escreve o handler. `ads`
 * continua sem nenhum verbo de escrita, por ausência de handler, e é o teste de
 * arquitetura que cobra isso.
 */
@ApiTags('Sync')
@ApiBearerAuth('access-token')
@Controller('/api/v1')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class SyncController {
  constructor(
    private readonly syncBatch: SyncAdsBatchUseCase,
    private readonly listQuarantine: ListQuarantineUseCase,
    private readonly rebind: RebindIntegrationUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Post('/ads/sync-batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Atualizar um lote de anúncios (② refresh dirigido)',
    description:
      'Coalesce os ids por conta numa única chamada de insights e responde `202`. ' +
      'Anúncio atualizado há menos de 60 s é ignorado pelo debounce — o produto não ' +
      'gasta a cota que protege as escritas para responder a um clique repetido.',
  })
  @ApiEnvelopeResponse(SyncBatchAcceptedDto, {
    status: 202,
    description: '`accepted` menor que o pedido significa debounce, não erro.',
  })
  @ApiDomainError(400, 'Lote vazio ou acima do teto.', ['SYNC_BATCH_EMPTY'])
  async syncAds(@CurrentUser() user: Account, @Body() body: SyncAdsBatchDto) {
    const result = await this.syncBatch.execute({
      organizationId: await this.organizationOf(user),
      adIds: body.adIds,
    });

    return envelope(result, {
      asOf: new Date().toISOString(),
      provenance: { engineVersion: 'sync-v2' },
    });
  }

  @Get('/sync/quarantine')
  @ApiOperation({
    summary: 'Anúncios em quarentena de sincronização',
    description:
      'O que o domínio não conseguiu absorver por não resolver campanha ou conjunto. ' +
      'Todo ingest tenta re-resolver a lista antes de processar: `attempts` alto é ' +
      'dívida real de integração, não fila de espera.',
  })
  @ApiQuery({ name: 'adAccountId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiEnvelopeResponse(QuarantineItemDto, {
    isArray: true,
    description:
      '`meta.asOf` é a última vez que **vimos** o item, não o instante da ' +
      'resposta: sem isso uma quarentena parada há três dias pareceria ' +
      'recém-detectada.',
  })
  async quarantine(
    @CurrentUser() user: Account,
    @Query('adAccountId') adAccountId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.listQuarantine.execute({
      organizationId: await this.organizationOf(user),
      adAccountId,
      cursor: cursor ?? null,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('/integrations/:platform/rebind')
  @ApiOperation({
    summary: 'Religar a credencial preservando a identidade (P10)',
    description:
      'Casa as contas por `(organização, plataforma, id externo)` — nunca por integração. ' +
      'Conta que a credencial nova não alcança vai a `UNREACHABLE`: **não** arquiva anúncios, ' +
      '**não** resolve desperdício e **não** expira recomendações.',
  })
  @ApiEnvelopeResponse(RebindResultDto, {
    description:
      'P10 — desconectar e reconectar preserva `ads.id`, `lineage_id` e as ' +
      'contagens. Nenhum id do cliente muda.',
  })
  async rebindIntegration(
    @CurrentUser() user: Account,
    @Param('platform') platform: string,
    @Body() body: RebindIntegrationDto,
  ) {
    return this.rebind.execute({
      accountId: user.id,
      platform: toPlatform(platform),
      integrationId: body.integrationId,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);

    if (!owner.organizationId) {
      throw new DomainError({
        code: 'ORGANIZATION_REQUIRED',
        category: 'NOT_PERMITTED',
        message: 'Selecione uma organização para operar a sincronização.',
        remediation: 'Envie o cabeçalho X-Organization-Id.',
      });
    }

    return owner.organizationId;
  }
}

const SUPPORTED_PLATFORMS: Record<string, Platform> = {
  meta: 'META',
  google: 'GOOGLE',
  tiktok: 'TIKTOK',
};

/**
 * Tabela em vez de `switch`: um condicional por plataforma fora de
 * `infrastructure/providers/` é violação de P6, e a regra de lint de A2-S0 a
 * recusa no CI.
 */
function toPlatform(raw: string): Platform {
  const platform = SUPPORTED_PLATFORMS[raw.toLowerCase()];

  if (!platform) {
    throw new DomainError({
      code: 'PLATFORM_NOT_SUPPORTED',
      category: 'UNSUPPORTED_BY_PLATFORM',
      message: `A plataforma "${raw}" não é suportada.`,
      details: { supported: Object.keys(SUPPORTED_PLATFORMS) },
    });
  }

  return platform;
}
