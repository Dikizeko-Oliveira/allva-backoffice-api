import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { CreateIntegrationOutputDto } from 'src/modules/integrations/application/dtos';
import { MetaApiService } from 'src/modules/integrations/meta/services/meta-api.service';
import { ConnectMetaAccountUseCase } from 'src/modules/integrations/meta/use-cases/connect-meta-account.use-case';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';

/**
 * Backwards-compat alias controller.
 * Equivalent to /api/v1/integrations/meta/(connect|callback) on the unified controller.
 */
@ApiTags('Gerenciar Integrações')
@Controller('/api/v1/integrations/meta')
export class MetaController {
  constructor(
    private readonly metaApiService: MetaApiService,
    private readonly connectMetaAccountUseCase: ConnectMetaAccountUseCase,
  ) {}

  /**
   * Mesma permissão da rota canônica (`GET /integrations/:platform/connect/url`):
   * um alias sem ela seria a porta dos fundos da conexão.
   */
  @Get('/connect')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: '[Alias] Iniciar conexao OAuth com Meta Ads' })
  @ApiResponse({
    status: 302,
    description: 'Redireciona o usuario para o consentimento da Meta',
  })
  async connect(
    @CurrentUser() user: Account,
    @Res() response: Response,
  ): Promise<void> {
    const authorizationUrl = await this.metaApiService.createAuthorizationUrl(
      user.id,
    );
    response.redirect(authorizationUrl);
  }

  @Get('/callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Alias] Callback OAuth da Meta Ads' })
  @ApiQuery({ name: 'code', required: false, type: String })
  @ApiQuery({ name: 'state', required: false, type: String })
  @ApiQuery({ name: 'error', required: false, type: String })
  @ApiQuery({ name: 'error_description', required: false, type: String })
  @ApiOkResponse({
    description: 'Integracao Meta persistida com sucesso',
    type: CreateIntegrationOutputDto,
  })
  @ApiUnauthorizedResponse({
    description: 'State invalido ou consentimento negado',
  })
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ): Promise<CreateIntegrationOutputDto> {
    if (error) {
      throw new UnauthorizedException({
        code: 'META_OAUTH_DENIED',
        message: errorDescription ?? 'Meta authorization was denied',
      });
    }

    if (!code || !state) {
      throw new UnauthorizedException({
        code: 'INVALID_META_CALLBACK',
        message: 'Meta callback requires valid code and state params',
      });
    }

    return this.connectMetaAccountUseCase.executeWithCallback(code, state);
  }
}
