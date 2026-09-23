import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottleLimit } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { Request } from 'express';
import { extractClientContext } from 'src/modules/security/infrastructure/http/client-context';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import {
  AcceptOrganizationInvitationInputDto,
  AcceptOrganizationInvitationOutputDto,
  CreateOrganizationInputDto,
  CreateOrganizationOutputDto,
  DeleteOrganizationOutputDto,
  ListOrganizationInvitationsOutputDto,
  ListOrganizationOutputDto,
  PreviewOrganizationInvitationOutputDto,
  RemoveOrganizationUserOutputDto,
  RevokeOrganizationInvitationOutputDto,
  SendOrganizationInvitationInputDto,
  SendOrganizationInvitationOutputDto,
  TransferOrganizationOwnershipInputDto,
  TransferOrganizationOwnershipOutputDto,
  UpdateOrganizationInputDto,
  UpdateOrganizationOutputDto,
  UpdateOrganizationUserRoleInputDto,
  UpdateOrganizationUserRoleOutputDto,
  UpdateOrganizationUserStatusInputDto,
  UpdateOrganizationUserStatusOutputDto,
  ListMyOrganizationsItemDto,
  OrganizationCreationAllowanceOutputDto,
} from 'src/modules/organizations/application/dtos';
import {
  AcceptOrganizationInvitationUseCase,
  CreateOrganizationUseCase,
  DeleteOrganizationUseCase,
  GetOrganizationCreationAllowanceUseCase,
  ListOrganizationInvitationsUseCase,
  ListOrganizationUseCase,
  ListMyOrganizationsUseCase,
  PreviewOrganizationInvitationUseCase,
  RemoveOrganizationUserUseCase,
  RevokeOrganizationInvitationUseCase,
  SendOrganizationInvitationUseCase,
  TransferOrganizationOwnershipUseCase,
  UpdateOrganizationUseCase,
  UpdateOrganizationUserRoleUseCase,
  UpdateOrganizationUserStatusUseCase,
} from 'src/modules/organizations/application/use-cases';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import { CurrentOrganization } from 'src/modules/organizations/infrastructure/http/decorators/current-organization.decorator';
import { RequireOrgRoles } from 'src/modules/organizations/infrastructure/http/decorators/require-org-roles.decorator';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import { ManageOrganizationAdsSettingsUseCase } from 'src/modules/organizations/application/use-cases/manage-organization-ads-settings.usecase';
import {
  OrganizationAdsSettingsOutputDto,
  UpdateOrganizationAdsSettingsInputDto,
} from 'src/modules/organizations/application/dtos/organization-ads-settings.dto';

@ApiTags('Gerenciar Organizações')
@Controller('/api/v1/organizations')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
export class OrganizationsController {
  constructor(
    private readonly createOrganizationUseCase: CreateOrganizationUseCase,
    private readonly listOrganizationUseCase: ListOrganizationUseCase,
    private readonly sendOrganizationInvitationUseCase: SendOrganizationInvitationUseCase,
    private readonly acceptOrganizationInvitationUseCase: AcceptOrganizationInvitationUseCase,
    private readonly previewOrganizationInvitationUseCase: PreviewOrganizationInvitationUseCase,
    private readonly listOrganizationInvitationsUseCase: ListOrganizationInvitationsUseCase,
    private readonly revokeOrganizationInvitationUseCase: RevokeOrganizationInvitationUseCase,
    private readonly updateOrganizationUseCase: UpdateOrganizationUseCase,
    private readonly updateOrganizationUserRoleUseCase: UpdateOrganizationUserRoleUseCase,
    private readonly updateOrganizationUserStatusUseCase: UpdateOrganizationUserStatusUseCase,
    private readonly removeOrganizationUserUseCase: RemoveOrganizationUserUseCase,
    private readonly transferOrganizationOwnershipUseCase: TransferOrganizationOwnershipUseCase,
    private readonly deleteOrganizationUseCase: DeleteOrganizationUseCase,
    private readonly listMyOrganizationsUseCase: ListMyOrganizationsUseCase,
    private readonly getCreationAllowanceUseCase: GetOrganizationCreationAllowanceUseCase,
    private readonly manageAdsSettings: ManageOrganizationAdsSettingsUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar organização e membros' })
  async listOrganization(
    @CurrentUser() user: Account,
  ): Promise<ListOrganizationOutputDto> {
    const accountId = user.id;

    return this.listOrganizationUseCase.execute(accountId);
  }

  /**
   * Rota própria, e antes de qualquer `:id`, porque a pergunta é outra: `GET
   * /organizations` devolve **a** organização ativa com seus membros, e o
   * seletor precisa saber entre quais alternar.
   */
  @Get('/mine')
  /**
   * Fora do teto de `accessStatus` — a saída de emergência do multi-organização.
   *
   * O status é resolvido **por organização** (`X-Organization-Id`), então uma
   * organização ativa bloqueada bloqueia todas as rotas daqui — inclusive esta.
   * O efeito era uma armadilha: quem tivesse uma organização vencida e outra em
   * dia ficava preso na vencida, sem conseguir nem listar a outra para trocar.
   * Pior, a tela de planos não resolveria, porque o problema não era o plano
   * dele — era qual workspace estava selecionado.
   *
   * Listar nomes de organizações que a conta já alcança não entrega produto
   * nenhum: é navegação. Quem trocar para uma organização bloqueada continua
   * batendo no teto em todas as outras rotas, que é onde o bloqueio pertence.
   */
  @AuthenticatedOnly()
  @ApiOperation({
    summary: 'Listar as organizações que a conta alcança',
    description:
      'Une posse (`ownerId`) e participação ativa. Alimenta o seletor de ' +
      'workspace — uma conta passou a poder alcançar várias.',
  })
  @ApiOkResponse({ type: [ListMyOrganizationsItemDto] })
  async listMyOrganizations(
    @CurrentUser() user: Account,
  ): Promise<ListMyOrganizationsItemDto[]> {
    return this.listMyOrganizationsUseCase.execute(user.id);
  }

  /**
   * O que `POST /organizations` responderia — sem gravar nada.
   *
   * Existe porque a tela precisa decidir se **mostra** o botão de criar, e a
   * única forma de perguntar era tentar: o usuário preenchia o formulário para
   * então descobrir que o plano dele inclui uma organização só. O front não tem
   * como responder sozinho — o teto negociado do contrato não está em catálogo
   * nenhum —, e uma cópia da regra lá divergiria desta no primeiro ajuste de
   * packaging.
   */
  @Get('/creation-allowance')
  /**
   * Fora do teto de `accessStatus`, pela mesma razão de `/mine`: o status é
   * resolvido por organização, então uma organização ativa vencida faria esta
   * rota falhar — e a tela, sem resposta, teria de adivinhar. Não entrega
   * produto nenhum: é a contagem que a própria conta já vê no seletor, com o
   * nome do plano que ela já vê no faturamento. A escrita segue guardada.
   */
  @AuthenticatedOnly()
  @ApiOperation({
    summary: 'Saber se a conta pode criar outra organização',
    description:
      'Mesma guarda de plano que `POST /organizations` aplica, sem o efeito ' +
      'colateral. Conta por **posse** e considera o teto negociado do contrato.',
  })
  @ApiOkResponse({ type: OrganizationCreationAllowanceOutputDto })
  async organizationCreationAllowance(
    @CurrentUser() user: Account,
  ): Promise<OrganizationCreationAllowanceOutputDto> {
    return this.getCreationAllowanceUseCase.execute(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Criar organização' })
  async createOrganization(
    @Body() dto: CreateOrganizationInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateOrganizationOutputDto> {
    const ownerId = user.id;

    return this.createOrganizationUseCase.execute(dto, ownerId);
  }

  /**
   * Envio, listagem e revogação de convite passam pelo `OrganizationAccessGuard`,
   * como as rotas de membro abaixo: quem pode é decidido pela participação
   * **ativa** na organização do `X-Organization-Id`, e o ator chega pronto em
   * `@CurrentOrganization()`.
   *
   * Antes cada caso de uso resolvia a organização a partir da conta, e sem
   * header essa resolução devolvia participação bloqueada ou congelada — que
   * passava pela checagem de papel.
   *
   * `POST /organizations/users` saiu junto: adicionava qualquer conta como membro
   * ativo, com papel até ADMIN, sem convite, sem consentimento, sem teto de
   * assentos e sem RBAC. Nenhuma tela o chamava.
   */
  @Post('/invitations')
  @UseGuards(OrganizationAccessGuard)
  @RequirePermissions('members:invite')
  @ApiOperation({
    summary:
      'Enviar convite seguro para organização (escopo via header X-Organization-Id)',
  })
  async sendOrganizationInvitation(
    @Body() dto: SendOrganizationInvitationInputDto,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<SendOrganizationInvitationOutputDto> {
    return this.sendOrganizationInvitationUseCase.execute(dto, org);
  }

  /**
   * Sem `OrganizationAccessGuard`, de propósito: quem aceita ainda não participa
   * da organização do convite. A autorização aqui é o token somado ao e-mail da
   * conta autenticada.
   */
  @Post('/invitations/accept')
  // Replay/brute-force protection: cap token-acceptance attempts per IP.
  @ThrottleLimit(10)
  @ApiOperation({ summary: 'Aceitar convite via token seguro' })
  async acceptOrganizationInvitation(
    @Body() dto: AcceptOrganizationInvitationInputDto,
    @CurrentUser() user: Account,
    @Req() req: Request,
  ): Promise<AcceptOrganizationInvitationOutputDto> {
    const accountId = user.id;

    return this.acceptOrganizationInvitationUseCase.execute(
      dto,
      accountId,
      extractClientContext(req),
    );
  }

  /**
   * Pública, de propósito: quem abre o link do convite por e-mail ainda não
   * tem sessão - é para login/cadastro que a tela de aceite manda essa pessoa
   * em seguida. `@Public()` ignora tanto o `AuthGuard` global quanto o
   * `EntitlementGuard`/`@RequireAccessStatuses` desta classe.
   *
   * Só o necessário para pré-preencher o formulário: e-mail e nome da
   * organização. Mesma recusa genérica do aceite (`INVITATION_INVALID`) para
   * token ausente, inexistente, expirado, revogado ou já usado - não é esta
   * rota, sem exigir autenticação, que vai diferenciar os motivos.
   */
  @Get('/invitations/preview')
  @Public()
  @ThrottleLimit(20)
  @ApiOperation({
    summary: 'Pré-visualizar convite (e-mail e organização) sem autenticação',
  })
  async previewOrganizationInvitation(
    @Query('token') token: string,
  ): Promise<PreviewOrganizationInvitationOutputDto> {
    return this.previewOrganizationInvitationUseCase.execute(token);
  }

  @Get('/invitations')
  @UseGuards(OrganizationAccessGuard)
  @RequirePermissions('members:invite')
  @ApiOperation({
    summary:
      'Listar convites da organização (escopo via header X-Organization-Id)',
  })
  async listOrganizationInvitations(
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<ListOrganizationInvitationsOutputDto> {
    return this.listOrganizationInvitationsUseCase.execute(org);
  }

  @Delete('/invitations/:id')
  @UseGuards(OrganizationAccessGuard)
  @RequirePermissions('members:invite')
  @ApiOperation({
    summary:
      'Revogar convite (soft-delete via revoked_at; só convites de rank inferior ao do ator)',
  })
  async revokeOrganizationInvitation(
    @Param('id') id: string,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<RevokeOrganizationInvitationOutputDto> {
    return this.revokeOrganizationInvitationUseCase.execute(id, org);
  }

  @Put()
  @ApiOperation({ summary: 'Editar dados da organização' })
  async updateOrganization(
    @Body() dto: UpdateOrganizationInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdateOrganizationOutputDto> {
    const ownerId = user.id;

    return this.updateOrganizationUseCase.execute(dto, ownerId);
  }

  @Patch('/users/:userId/role')
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER', 'ADMIN')
  @RequirePermissions('members:update_role')
  @ApiOperation({
    summary:
      'Alterar role de um membro (escopo via header X-Organization-Id). :userId = accountId do alvo.',
  })
  async updateOrganizationUserRole(
    @Param('userId') userId: string,
    @Body() dto: UpdateOrganizationUserRoleInputDto,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<UpdateOrganizationUserRoleOutputDto> {
    return this.updateOrganizationUserRoleUseCase.execute(org, userId, dto);
  }

  @Patch('/users/:userId/status')
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER', 'ADMIN')
  @RequirePermissions('members:update_status')
  @ApiOperation({
    summary:
      'Alterar status de um membro (ACTIVE/BLOCKED/REMOVED). :userId = accountId do alvo.',
  })
  async updateOrganizationUserStatus(
    @Param('userId') userId: string,
    @Body() dto: UpdateOrganizationUserStatusInputDto,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<UpdateOrganizationUserStatusOutputDto> {
    return this.updateOrganizationUserStatusUseCase.execute(org, userId, dto);
  }

  @Delete('/users/:userId')
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER', 'ADMIN')
  @RequirePermissions('members:remove')
  @ApiOperation({
    summary:
      'Remover um membro (soft-delete via status REMOVED). :userId = accountId do alvo.',
  })
  async removeOrganizationUser(
    @Param('userId') userId: string,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<RemoveOrganizationUserOutputDto> {
    return this.removeOrganizationUserUseCase.execute(org, userId);
  }

  @Post('/transfer-ownership')
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER')
  @RequirePermissions('organization:update')
  @ApiOperation({
    summary:
      'Transferir a posse da organização para outro membro ativo (somente OWNER, escopo via header X-Organization-Id).',
  })
  async transferOrganizationOwnership(
    @Body() dto: TransferOrganizationOwnershipInputDto,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<TransferOrganizationOwnershipOutputDto> {
    return this.transferOrganizationOwnershipUseCase.execute(
      org,
      dto.newOwnerAccountId,
    );
  }

  /**
   * A janela de análise — leitura para qualquer membro que já vê os números.
   *
   * `analytics:read` e não `organization:update`: a janela é o que explica o
   * que a Visão Geral e o relatório estão medindo, e esconder a explicação de
   * quem pode ver o número deixaria a tela sem como declarar a própria
   * procedência. Escrever é outra história, logo abaixo.
   */
  @Get('/ads-settings')
  @UseGuards(OrganizationAccessGuard)
  @RequirePermissions('analytics:read')
  @ApiOperation({
    summary:
      'Ler a janela de análise da organização (escopo via header X-Organization-Id).',
  })
  @ApiOkResponse({ type: OrganizationAdsSettingsOutputDto })
  async readAdsSettings(
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<OrganizationAdsSettingsOutputDto> {
    return this.manageAdsSettings.read(org);
  }

  /**
   * Alterar a janela muda a régua de **todas** as telas de inteligência da
   * organização, e o efeito aparece no ciclo de scoring seguinte. Por isso
   * OWNER/ADMIN com `organization:update`, e não a permissão de quem só lê.
   */
  @Patch('/ads-settings')
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER', 'ADMIN')
  @RequirePermissions('organization:update')
  @ApiOperation({
    summary:
      'Alterar a janela de análise da organização. Vale para scoring, desperdício, Visão Geral e relatórios.',
  })
  @ApiBody({ type: UpdateOrganizationAdsSettingsInputDto })
  @ApiOkResponse({ type: OrganizationAdsSettingsOutputDto })
  async updateAdsSettings(
    @Body() dto: UpdateOrganizationAdsSettingsInputDto,
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<OrganizationAdsSettingsOutputDto> {
    return this.manageAdsSettings.update(org, dto);
  }

  @Delete()
  @UseGuards(OrganizationAccessGuard)
  @RequireOrgRoles('OWNER')
  @RequirePermissions('organization:update')
  @ApiOperation({
    summary:
      'Excluir a organização (soft-delete via deleted_at; somente OWNER, escopo via header X-Organization-Id).',
  })
  async deleteOrganization(
    @CurrentOrganization() org: OrganizationContext,
  ): Promise<DeleteOrganizationOutputDto> {
    return this.deleteOrganizationUseCase.execute(org);
  }
}
