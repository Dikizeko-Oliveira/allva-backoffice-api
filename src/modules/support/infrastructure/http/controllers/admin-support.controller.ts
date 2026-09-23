import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  AdminSupportTicketDetailOutputDto,
  CreateAdminSupportMessageInputDto,
  ListAdminSupportTicketsOutputDto,
  ListAdminSupportTicketsQueryDto,
  SupportTicketMessageDto,
  UpdateAdminSupportTicketInputDto,
} from 'src/modules/support/application/dtos';
import {
  CreateAdminSupportMessageUseCase,
  GetAdminSupportTicketUseCase,
  ListAdminSupportTicketsUseCase,
  UpdateAdminSupportTicketUseCase,
} from 'src/modules/support/application/use-cases';

/**
 * A fila de atendimento, sob `/admin` e restrita a quem opera a plataforma.
 *
 * Mesmo desenho de `AdminSalesLeadsController`: prefixo `/admin`, autorização
 * no use case via `PlatformRoleService`, e **sem** `EntitlementGuard` — um
 * operador não tem assinatura, e costuma estar mexendo justamente na conta de
 * quem está bloqueado.
 *
 * ## O nome do recurso mudou em relação ao mapa
 *
 * O mapa de endpoints do backoffice propõe `/admin/support/messages` (B10).
 * Aqui é `/admin/support/tickets`, com `/tickets/:id/messages` embaixo:
 * "messages" virou um sub-recurso de verdade quando a conversa ganhou tabela,
 * e manter o nome antigo no pai faria `/admin/support/messages/:id/messages`.
 *
 * ## Permissões
 *
 * Leitura (`GET`) exige `support:read`; escrita (`PATCH`, mensagens) exige
 * `support:manage` — a mesma separação que o painel aplica nas Server
 * Actions dele. Hoje as duas vão juntas para suporte e administração, e
 * separadas elas continuam certas no dia em que um papel ganhar só a leitura.
 */
@ApiTags('Suporte')
@ApiBearerAuth()
@Controller('/api/v1/admin/support/tickets')
export class AdminSupportController {
  constructor(
    private readonly listAdminSupportTicketsUseCase: ListAdminSupportTicketsUseCase,
    private readonly getAdminSupportTicketUseCase: GetAdminSupportTicketUseCase,
    private readonly updateAdminSupportTicketUseCase: UpdateAdminSupportTicketUseCase,
    private readonly createAdminSupportMessageUseCase: CreateAdminSupportMessageUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar a fila de atendimento (cross-org)',
    description:
      'Exige a permissão de plataforma `support:read`. Traz nome da organização, plano e responsável já resolvidos — sem eles cada linha custaria dois GET extras.',
  })
  @ApiOkResponse({ type: ListAdminSupportTicketsOutputDto })
  async list(
    @Query() query: ListAdminSupportTicketsQueryDto,
    @CurrentUser() user: Account,
  ): Promise<ListAdminSupportTicketsOutputDto> {
    return this.listAdminSupportTicketsUseCase.execute(query, user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Abrir um chamado no painel, com a conversa inteira',
    description:
      'Exige a permissão de plataforma `support:read`. Inclui `INTERNAL_NOTE` — é a diferença para a rota do cliente.',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailOutputDto })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Account,
  ): Promise<AdminSupportTicketDetailOutputDto> {
    return this.getAdminSupportTicketUseCase.execute(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atribuir responsável e/ou mudar o status',
    description:
      'Exige a permissão de plataforma `support:manage`. `assigneeId: null` desatribui. Grava trilha de auditoria por fato alterado.',
  })
  @ApiOkResponse({ type: AdminSupportTicketDetailOutputDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminSupportTicketInputDto,
    @CurrentUser() user: Account,
  ): Promise<AdminSupportTicketDetailOutputDto> {
    return this.updateAdminSupportTicketUseCase.execute(id, dto, user.id);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Responder ao cliente ou registrar nota interna',
    description:
      'Exige a permissão de plataforma `support:manage`. `INTERNAL_NOTE` nunca chega às rotas do cliente e não move a ordenação da fila.',
  })
  @ApiCreatedResponse({ type: SupportTicketMessageDto })
  async createMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAdminSupportMessageInputDto,
    @CurrentUser() user: Account,
  ): Promise<SupportTicketMessageDto> {
    return this.createAdminSupportMessageUseCase.execute(id, dto, user.id);
  }
}
