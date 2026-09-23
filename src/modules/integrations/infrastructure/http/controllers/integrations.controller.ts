import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import {
  CreateAdAccountInputDto,
  CreateAdAccountOutputDto,
  CreateIntegrationInputDto,
  CreateIntegrationOutputDto,
  DisconnectIntegrationResponseDto,
  LinkAdAccountInputDto,
  LinkAdAccountResponseDto,
  ListExternalAdAccountsResponseDto,
  ListIntegrationsOutputDto,
  SyncStatusResponseDto,
  UnlinkAdAccountResponseDto,
} from 'src/modules/integrations/application/dtos';
import {
  CreateAdAccountUseCase,
  CreateIntegrationUseCase,
  DisconnectIntegrationUseCase,
  GetIntegrationSyncStatusUseCase,
  LinkAdAccountUseCase,
  ListIntegrationsUseCase,
  ListPlatformAdAccountsUseCase,
  UnlinkAdAccountUseCase,
} from 'src/modules/integrations/application/use-cases';
import {
  Platform,
  slugToPlatform,
} from 'src/modules/integrations/domain/entities/platform';
import { ConnectGoogleAccountUseCase } from 'src/modules/integrations/google/use-cases/connect-google-account.use-case';
import { AdAccountFreezeUseCase } from 'src/modules/integrations/application/use-cases/ad-account-freeze.usecase';
import { SeatFreezeUseCase } from 'src/modules/integrations/application/use-cases/seat-freeze.usecase';
import {
  FreezeSelectionInputDto,
  SeatFreezeSelectionInputDto,
} from 'src/modules/integrations/application/dtos/freeze-selection.dto';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { ConnectMetaAccountUseCase } from 'src/modules/integrations/meta/use-cases/connect-meta-account.use-case';
import { ConnectTikTokAccountUseCase } from 'src/modules/integrations/tiktok/use-cases/connect-tiktok-account.use-case';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import { DeprecatedEndpoint } from 'src/shared/infrastructure/http/deprecated-endpoint.decorator';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { ThrottlePolicy } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';

function resolvePlatformOrFail(platformParam: string) {
  const platform = slugToPlatform(platformParam);
  if (!platform) {
    throw new BadRequestException({
      code: 'PLATFORM_NOT_AVAILABLE',
      message: `Platform "${platformParam}" is not supported`,
    });
  }
  return platform;
}

/**
 * **Escrita exige `integrations:manage`; leitura segue aberta a membro ativo.**
 *
 * Conectar, desconectar e (des)vincular contas só checavam escopo — participação
 * ativa na organização. Um VIEWER, que nem `integrations:read` tem na matriz,
 * desconectava a Meta da organização inteira. A permissão existia e nenhuma rota
 * a pedia.
 *
 * As leituras ficam como estavam. Fechá-las com `integrations:read` tiraria
 * FINANCE e VIEWER de toda tela que consulta o estado das integrações — é
 * decisão de produto, não parte desta correção.
 */
@ApiTags('Gerenciar Integrações')
@Controller('/api/v1/integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly createIntegrationUseCase: CreateIntegrationUseCase,
    private readonly createAdAccountUseCase: CreateAdAccountUseCase,
    private readonly listIntegrationsUseCase: ListIntegrationsUseCase,
    private readonly listPlatformAdAccountsUseCase: ListPlatformAdAccountsUseCase,
    private readonly linkAdAccountUseCase: LinkAdAccountUseCase,
    private readonly unlinkAdAccountUseCase: UnlinkAdAccountUseCase,
    private readonly disconnectIntegrationUseCase: DisconnectIntegrationUseCase,
    private readonly getSyncStatusUseCase: GetIntegrationSyncStatusUseCase,
    private readonly providers: AdsProviderFactory,
    private readonly connectMetaAccountUseCase: ConnectMetaAccountUseCase,
    private readonly connectGoogleAccountUseCase: ConnectGoogleAccountUseCase,
    private readonly connectTikTokAccountUseCase: ConnectTikTokAccountUseCase,
    private readonly envService: EnvService,
    private readonly adAccountFreeze: AdAccountFreezeUseCase,
    private readonly seatFreeze: SeatFreezeUseCase,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  /**
   * Despacho do callback OAuth por plataforma, como tabela e não como `if`
   * (P6). A diferença entre as três continua existindo — as assinaturas dos use
   * cases divergem —, mas ela fica declarada num lugar exaustivo: uma
   * plataforma nova aparece aqui como chave faltando, verificada por `tsc`, em
   * vez de cair silenciosamente no `else` da anterior.
   */
  private oauthCallbackHandlers(): Record<
    Platform,
    (code: string, state: string) => Promise<unknown>
  > {
    return {
      META: (code, state) =>
        this.connectMetaAccountUseCase.executeWithCallback(code, state),
      GOOGLE: (code, state) =>
        this.connectGoogleAccountUseCase.execute(code, state),
      TIKTOK: (code, state) =>
        this.connectTikTokAccountUseCase.execute(code, state),
    };
  }

  // -----------------------------------------------------------
  // Listing & legacy create endpoints
  // -----------------------------------------------------------

  @Get()
  @UseGuards(EntitlementGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({ summary: 'Listar integrações' })
  async listIntegrations(
    @CurrentUser() user: Account,
  ): Promise<ListIntegrationsOutputDto> {
    return this.listIntegrationsUseCase.execute(user.id);
  }

  /**
   * @deprecated Use the OAuth flow at GET /integrations/:platform/connect instead.
   */
  @Post()
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @DeprecatedEndpoint({
    replacedBy: 'GET /api/v1/integrations/{platform}/connect/url',
    note:
      'A integração nasce do fluxo OAuth, que é quem obtém e cifra a credencial. ' +
      'Criar uma à mão produz registro sem token utilizável.',
  })
  @ApiOperation({ summary: '[Deprecated] Criar integração manualmente' })
  async createIntegration(
    @Body() dto: CreateIntegrationInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateIntegrationOutputDto> {
    return this.createIntegrationUseCase.execute(dto, user.id);
  }

  /**
   * @deprecated Use POST /integrations/:platform/accounts instead.
   */
  @Post('/ad-accounts')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @DeprecatedEndpoint({
    replacedBy: 'POST /api/v1/integrations/{platform}/accounts',
    note:
      'A canônica vincula uma conta que a plataforma de fato expõe para a ' +
      'credencial conectada; esta aqui aceita um id externo digitado, que pode ' +
      'não existir ou não ser acessível.',
  })
  @ApiOperation({ summary: '[Deprecated] Criar conta de anúncios manualmente' })
  async createAdAccount(
    @Body() dto: CreateAdAccountInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateAdAccountOutputDto> {
    return this.createAdAccountUseCase.execute(dto, user.id);
  }

  // -----------------------------------------------------------
  // Unified per-platform routes
  // -----------------------------------------------------------

  /**
   * `GET`, mas é o primeiro passo de uma escrita: a URL devolvida termina numa
   * credencial gravada na organização. Por isso a mesma permissão do resto.
   */
  @Get('/:platform/connect/url')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Obter URL OAuth para abrir popup de conexão' })
  async connectUrl(
    @Param('platform') platformParam: string,
    @CurrentUser() user: Account,
  ): Promise<{ url: string }> {
    const platform = resolvePlatformOrFail(platformParam);
    const provider = this.providers.for(platform);

    /**
     * A organização selecionada viaja no `state`, assinada.
     *
     * Sem ela, o callback resolvia a organização pela participação ativa mais
     * antiga da conta e ignorava o seletor de workspace: quem participa de duas
     * escolhia a B, via `oauth=success`, e a credencial tinha ido para a A —
     * onde ficava utilizável por membros que não participaram da conexão.
     */
    const owner = await this.ownerScope.resolveForAccount(user.id);

    const url = await provider.getAuthorizationUrl({
      accountId: user.id,
      organizationId: owner.organizationId ?? undefined,
    });
    return { url };
  }

  @Get('/:platform/callback')
  @Public()
  @ApiOperation({
    summary: 'Callback OAuth da plataforma (redireciona para o frontend)',
  })
  @ApiQuery({ name: 'code', required: false, type: String })
  @ApiQuery({ name: 'state', required: false, type: String })
  @ApiQuery({ name: 'error', required: false, type: String })
  @ApiQuery({ name: 'error_description', required: false, type: String })
  async callback(
    @Param('platform') platformParam: string,
    @Res() response: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    const frontendBase =
      (this.envService.get('FRONTEND_URL') ?? '') + '/account/integrations';

    if (error) {
      response.redirect(
        `${frontendBase}?oauth=error&platform=${platformParam}&code=OAUTH_DENIED`,
      );
      return;
    }

    if (!code || !state) {
      response.redirect(
        `${frontendBase}?oauth=error&platform=${platformParam}&code=INVALID_CALLBACK`,
      );
      return;
    }

    const platform = resolvePlatformOrFail(platformParam);

    try {
      await this.oauthCallbackHandlers()[platform](code, state);

      response.redirect(
        `${frontendBase}?oauth=success&platform=${platformParam}`,
      );
    } catch (err) {
      this.logger.error(
        `OAuth callback failed for platform=${platformParam}`,
        err,
      );
      response.redirect(
        `${frontendBase}?oauth=error&platform=${platformParam}&code=OAUTH_FAILED`,
      );
    }
  }

  @Delete('/:platform/disconnect')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiOperation({ summary: 'Desconectar integração da plataforma' })
  @ApiOkResponse({ type: DisconnectIntegrationResponseDto })
  async disconnect(
    @Param('platform') platformParam: string,
    @CurrentUser() user: Account,
  ): Promise<DisconnectIntegrationResponseDto> {
    const platform = resolvePlatformOrFail(platformParam);
    return this.disconnectIntegrationUseCase.execute(user.id, platform);
  }

  @Get('/:platform/accounts')
  @UseGuards(EntitlementGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({
    summary: 'Listar contas de anúncio disponíveis na plataforma',
  })
  @ApiOkResponse({ type: ListExternalAdAccountsResponseDto })
  async listPlatformAccounts(
    @Param('platform') platformParam: string,
    @CurrentUser() user: Account,
  ): Promise<ListExternalAdAccountsResponseDto> {
    const platform = resolvePlatformOrFail(platformParam);
    return this.listPlatformAdAccountsUseCase.execute(user.id, platform);
  }

  /**
   * O que o downgrade agendado vai congelar — **antes** de ele valer.
   *
   * Separado da execução de propósito: a tela precisa mostrar a consequência e
   * deixar o usuário escolher, e um endpoint que só aplicasse obrigaria a
   * descobrir o efeito depois de causá-lo.
   */
  @Get('/ad-accounts/freeze-preview')
  @UseGuards(EntitlementGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({
    summary: 'O que ficará congelado quando o plano encolher',
    description:
      '`forced` são contas cuja plataforma não está no plano de destino: elas ' +
      'congelam de qualquer forma e **não** podem ser escolhidas. Entre as de ' +
      '`selectable`, o usuário escolhe quais ficam ativas. Sem downgrade ' +
      'agendado, responde com o plano vigente e nada a congelar.',
  })
  async freezePreview(@CurrentUser() user: Account) {
    return this.adAccountFreeze.previewForAccount(user.id);
  }

  /**
   * A escolha do usuário sobre quais contas ficam ativas.
   *
   * Aceita a lista do que **fica**, não do que congela: é a pergunta que a tela
   * faz ("quais dessas você quer manter?"), e inverter aqui faria o cliente
   * enumerar o que perde.
   */
  @Put('/ad-accounts/freeze-selection')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiOperation({
    summary: 'Escolher quais contas ficam ativas após o downgrade',
    description:
      'Só vale enquanto houver downgrade agendado. Recusa conta de plataforma ' +
      'fora do plano de destino e seleção acima do teto.',
  })
  @ApiDomainError(403, 'Seleção incompatível com o plano de destino.', [
    'AD_ACCOUNT_NOT_SELECTABLE',
    'AD_ACCOUNT_SELECTION_EXCEEDS_QUOTA',
  ])
  async freezeSelection(
    @CurrentUser() user: Account,
    @Body() dto: FreezeSelectionInputDto,
  ) {
    return this.adAccountFreeze.chooseForAccount(
      user.id,
      dto.keepActiveAdAccountIds,
    );
  }

  @Get('/seats/freeze-preview')
  @UseGuards(EntitlementGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({
    summary: 'Quem perderá acesso quando o teto de assentos encolher',
    description:
      '`protectedSeats` é o dono: nunca congela, **ocupa** assento e não entra ' +
      'na escolha. Entre `selectable`, o usuário escolhe quem mantém acesso.',
  })
  async seatFreezePreview(@CurrentUser() user: Account) {
    return this.seatFreeze.previewForAccount(user.id);
  }

  /**
   * Escolher quem mantém acesso é decidir sobre membros: `members:update_status`,
   * a mesma permissão de bloquear alguém à mão. Sem ela qualquer membro ativo
   * escolhia quem da organização perdia o assento.
   */
  @Put('/seats/freeze-selection')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('members:update_status')
  @ApiOperation({
    summary: 'Escolher quem mantém acesso após o downgrade',
  })
  @ApiDomainError(403, 'Seleção incompatível com o plano de destino.', [
    'MEMBERSHIP_NOT_SELECTABLE',
    'MEMBERSHIP_SELECTION_EXCEEDS_QUOTA',
  ])
  async seatFreezeSelection(
    @CurrentUser() user: Account,
    @Body() dto: SeatFreezeSelectionInputDto,
  ) {
    return this.seatFreeze.chooseForAccount(
      user.id,
      dto.keepActiveMembershipIds,
    );
  }

  @Post('/:platform/accounts')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiOperation({ summary: 'Vincular uma conta de anúncio da plataforma' })
  @ApiOkResponse({ type: LinkAdAccountResponseDto })
  async linkAccount(
    @Param('platform') platformParam: string,
    @Body() dto: LinkAdAccountInputDto,
    @CurrentUser() user: Account,
  ): Promise<LinkAdAccountResponseDto> {
    const platform = resolvePlatformOrFail(platformParam);
    return this.linkAdAccountUseCase.execute(user.id, platform, dto);
  }

  @Delete('/:platform/accounts/:accountId')
  @UseGuards(EntitlementGuard, OrganizationAccessGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @RequirePermissions('integrations:manage')
  @ApiOperation({ summary: 'Desvincular conta de anúncio (soft-delete)' })
  @ApiOkResponse({ type: UnlinkAdAccountResponseDto })
  async unlinkAccount(
    @Param('platform') platformParam: string,
    @Param('accountId') accountId: string,
    @CurrentUser() user: Account,
  ): Promise<UnlinkAdAccountResponseDto> {
    const platform = resolvePlatformOrFail(platformParam);
    return this.unlinkAdAccountUseCase.execute(user.id, platform, accountId);
  }

  @Get('/:platform/sync-status')
  @UseGuards(EntitlementGuard)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  // The UI polls this while a sync runs. Its own budget, so a tab left open on the
  // integrations page cannot spend the account's interactive allowance.
  @ThrottlePolicy('polling')
  @ApiOperation({ summary: 'Status atual de sincronização da plataforma' })
  @ApiOkResponse({ type: SyncStatusResponseDto })
  async syncStatus(
    @Param('platform') platformParam: string,
    @CurrentUser() user: Account,
  ): Promise<SyncStatusResponseDto> {
    const platform = resolvePlatformOrFail(platformParam);
    return this.getSyncStatusUseCase.execute(user.id, platform);
  }
}
