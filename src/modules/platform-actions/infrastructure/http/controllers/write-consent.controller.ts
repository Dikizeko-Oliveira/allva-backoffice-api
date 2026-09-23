import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import {
  KillSwitchStateDto,
  WriteConsentDto,
  WriteConsentsResponseDto,
} from 'src/modules/platform-actions/application/dtos/responses/platform-action-response.dto';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import {
  GrantWriteConsentDto,
  ToggleKillSwitchDto,
} from 'src/modules/platform-actions/application/dtos/write-consent.dto';
import {
  GrantWriteConsentUseCase,
  ListWriteConsentsUseCase,
  RevokeWriteConsentUseCase,
  ToggleActionsKillSwitchUseCase,
} from 'src/modules/platform-actions/application/use-cases/write-consent.usecases';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * Os dois controles de §13.5, e eles são **distintos**.
 *
 * O consentimento vive por integração e por tipo de ação; o kill switch é da
 * organização e vale para tudo. Quem precisa parar uma escrita em curso usa o
 * segundo — o primeiro exigiria revogar autorizações que depois teriam de ser
 * reconcedidas item a item.
 *
 * As duas rotas de mudança exigem `actions:consent_manage` e
 * `actions:kill_switch`, que só `OWNER` e `ADMIN` têm: são governança da
 * organização, não tarefa de quem opera campanhas.
 */
@ApiTags('Platform Actions')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads/actions')
@UseGuards(EntitlementGuard, OrganizationAccessGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class WriteConsentController {
  constructor(
    private readonly grantConsent: GrantWriteConsentUseCase,
    private readonly revokeConsent: RevokeWriteConsentUseCase,
    private readonly listConsents: ListWriteConsentsUseCase,
    private readonly toggleKillSwitch: ToggleActionsKillSwitchUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/consents')
  @RequirePermissions('actions:read')
  @ApiOperation({
    summary: 'Consentimentos de escrita da organização',
    description:
      'Inclui os revogados: a trilha de quem autorizou o quê, e até quando, é o ponto.',
  })
  @ApiEnvelopeResponse(WriteConsentsResponseDto, {
    description:
      'Os consentimentos e os três portões de escrita, separados: consentir ' +
      'não adianta se a instalação não escreve, e nenhum dos dois adianta com ' +
      'o kill switch acionado.',
  })
  async list(@CurrentUser() user: Account) {
    return this.listConsents.execute({
      organizationId: await this.organizationOf(user),
    });
  }

  @Post('/consents/:integrationId')
  @RequirePermissions('actions:consent_manage')
  @ApiOperation({
    summary: 'Conceder consentimento de escrita para uma integração',
    description:
      'Substitui o consentimento anterior. Os tipos são listados um a um — ' +
      'não há atalho para "todos".',
  })
  @ApiEnvelopeResponse(WriteConsentDto, {
    description:
      'Conceder **revoga o anterior no mesmo ato**: duas linhas vivas para a ' +
      'mesma integração obrigariam a leitura a escolher uma, e o critério ' +
      'errado autorizaria mais do que o usuário concedeu por último.',
  })
  async grant(
    @CurrentUser() user: Account,
    @Param('integrationId') integrationId: string,
    @Body() body: GrantWriteConsentDto,
    @Req() request: Request,
  ) {
    return this.grantConsent.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      integrationId,
      body,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });
  }

  @Delete('/consents/:integrationId')
  @RequirePermissions('actions:consent_manage')
  @ApiOperation({
    summary: 'Revogar o consentimento de escrita',
    description: 'Revogação é **soft** — a trilha não se apaga.',
  })
  @ApiEnvelopeResponse(WriteConsentDto)
  async revoke(
    @CurrentUser() user: Account,
    @Param('integrationId') integrationId: string,
    @Req() request: Request,
  ) {
    return this.revokeConsent.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      integrationId,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });
  }

  @Put('/kill-switch')
  @RequirePermissions('actions:kill_switch')
  @ApiOperation({
    summary: 'Ligar ou desligar todas as ações da organização',
    description:
      'Vale a partir da próxima requisição de escrita: a flag é lida do banco ' +
      'a cada pedido, sem cache.',
  })
  @ApiEnvelopeResponse(KillSwitchStateDto)
  async killSwitch(
    @CurrentUser() user: Account,
    @Body() body: ToggleKillSwitchDto,
    @Req() request: Request,
  ) {
    return this.toggleKillSwitch.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      enabled: body.enabled,
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
      message: 'Selecione uma organização para gerir a escrita em plataforma.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
