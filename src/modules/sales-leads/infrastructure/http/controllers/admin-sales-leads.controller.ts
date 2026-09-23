import {
  Body,
  Controller,
  Get,
  Param,
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
  CreateAdminSalesLeadInputDto,
  CreateSalesLeadOutputDto,
  ListSalesLeadsOutputDto,
  ListSalesLeadsQueryDto,
  SalesLeadOutputDto,
  UpdateSalesLeadStatusInputDto,
  UpdateSalesLeadStatusOutputDto,
} from '../../../application/dtos';
import {
  CreateAdminSalesLeadUseCase,
  GetSalesLeadUseCase,
  ListSalesLeadsUseCase,
  UpdateSalesLeadStatusUseCase,
} from '../../../application/use-cases';

/**
 * O pipeline comercial, sob `/admin` e restrito a quem opera a plataforma.
 *
 * Estas três rotas viviam em `/api/v1/sales-leads` pedindo apenas sessão válida.
 * Qualquer cliente logado listava a base de leads inteira — nome, e-mail
 * corporativo, telefone, empresa, estágio da negociação — e, pior, movia
 * qualquer lead para `CLOSED_WON`, que **provisiona uma organização
 * Enterprise**. Autoatendimento de plano negociado, de graça.
 *
 * O prefixo `/admin` é o mesmo de `OrganizationQuotasController`, e a razão é a
 * mesma: o público destas rotas não é o dono de uma organização, é quem fecha
 * contrato. Misturá-las com as rotas de produto obrigaria as guardas de
 * organização a abrir exceção para operador, que é como um bypass nasce.
 *
 * A autorização mora no use case, via `PlatformRoleService` — não no controller.
 * É onde as outras superfícies administrativas já a fazem, e é o que garante que
 * um segundo chamador (um job, o backoffice por outra porta) não escape dela.
 */
@ApiTags('Sales Leads')
@ApiBearerAuth()
@Controller('/api/v1/admin/sales-leads')
export class AdminSalesLeadsController {
  constructor(
    private readonly createAdminSalesLeadUseCase: CreateAdminSalesLeadUseCase,
    private readonly listSalesLeadsUseCase: ListSalesLeadsUseCase,
    private readonly getSalesLeadUseCase: GetSalesLeadUseCase,
    private readonly updateSalesLeadStatusUseCase: UpdateSalesLeadStatusUseCase,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Cadastrar lead de vendas',
    description:
      'Exige a permissão de plataforma `leads:manage`. Para o negócio que não entrou ' +
      'pelo site — indicação, evento, conversa. Diferente da rota pública, ' +
      'não exige e-mail corporativo: a triagem aqui é a pessoa que cadastra.',
  })
  @ApiCreatedResponse({ type: CreateSalesLeadOutputDto })
  async create(
    @Body() dto: CreateAdminSalesLeadInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateSalesLeadOutputDto> {
    return this.createAdminSalesLeadUseCase.execute(dto, user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar leads de vendas',
    description: 'Exige a permissão de plataforma `leads:read`.',
  })
  @ApiOkResponse({ type: ListSalesLeadsOutputDto })
  async list(
    @Query() query: ListSalesLeadsQueryDto,
    @CurrentUser() user: Account,
  ): Promise<ListSalesLeadsOutputDto> {
    return this.listSalesLeadsUseCase.execute(query, user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Obter lead de vendas por ID',
    description: 'Exige a permissão de plataforma `leads:read`.',
  })
  @ApiOkResponse({ type: SalesLeadOutputDto })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: Account,
  ): Promise<SalesLeadOutputDto> {
    return this.getSalesLeadUseCase.execute(id, user.id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Atualizar status do lead de vendas',
    description:
      'Exige a permissão de plataforma `leads:manage`. `CLOSED_WON` dispara o ' +
      'provisionamento da organização Enterprise e é irreversível.',
  })
  @ApiOkResponse({ type: UpdateSalesLeadStatusOutputDto })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateSalesLeadStatusInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdateSalesLeadStatusOutputDto> {
    return this.updateSalesLeadStatusUseCase.execute(id, dto, user.id);
  }
}
