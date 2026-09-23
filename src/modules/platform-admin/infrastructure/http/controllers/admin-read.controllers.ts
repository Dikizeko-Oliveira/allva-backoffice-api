import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  AdminAccountDetailDto,
  AdminAuditEventsPageDto,
  AdminCustomersPageDto,
  AdminIntegrationsPageDto,
  AdminInvoicesPageDto,
  AdminJobRunsPageDto,
  AdminOperatorsPageDto,
  AdminOrganizationDetailDto,
  AdminOrganizationsPageDto,
  AdminOverviewDto,
  AdminSubscriptionsPageDto,
  ListAdminAuditLogsQueryDto,
  ListAdminCustomersQueryDto,
  ListAdminIntegrationsQueryDto,
  ListAdminInvoicesQueryDto,
  ListAdminJobRunsQueryDto,
  ListAdminOperatorsQueryDto,
  ListAdminOrganizationsQueryDto,
  ListAdminSubscriptionsQueryDto,
} from 'src/modules/platform-admin/application/dtos';
import {
  GetAdminAccountUseCase,
  GetAdminOrganizationUseCase,
  GetAdminOverviewUseCase,
  ListAdminAuditLogsUseCase,
  ListAdminCustomersUseCase,
  ListAdminIntegrationsUseCase,
  ListAdminInvoicesUseCase,
  ListAdminJobRunsUseCase,
  ListAdminOperatorsUseCase,
  ListAdminOrganizationsUseCase,
  ListAdminSubscriptionsUseCase,
} from 'src/modules/platform-admin/application/use-cases';

/**
 * As leituras cross-org do painel de operador, sob `/admin`.
 *
 * Mesmo desenho das outras superfícies administrativas: autorização no use
 * case (cada rota nomeia a permissão que exige), sem `EntitlementGuard` —
 * operador não tem assinatura. Todas são `GET`; escrever continua nos módulos
 * donos do dado.
 */

@ApiTags('Admin - Organizações')
@ApiBearerAuth()
@Controller('/api/v1/admin/organizations')
export class AdminOrganizationsController {
  constructor(
    private readonly listUseCase: ListAdminOrganizationsUseCase,
    private readonly getUseCase: GetAdminOrganizationUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar organizações da plataforma (cross-org)',
    description:
      'Exige `orgs:read`. Estado derivado da assinatura, plano, titular, uso e teto efetivo de cota.',
  })
  @ApiOkResponse({ type: AdminOrganizationsPageDto })
  list(
    @Query() query: ListAdminOrganizationsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.listUseCase.execute(query, user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalhar uma organização',
    description:
      'Exige `orgs:read`. Traz contato, membros e as quatro linhas de cota (usado, negociado, teto do plano, efetivo).',
  })
  @ApiOkResponse({ type: AdminOrganizationDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Account) {
    return this.getUseCase.execute(id, user.id);
  }
}

@ApiTags('Admin - Contas')
@ApiBearerAuth()
@Controller('/api/v1/admin/accounts')
export class AdminAccountsReadController {
  constructor(
    private readonly customersUseCase: ListAdminCustomersUseCase,
    private readonly operatorsUseCase: ListAdminOperatorsUseCase,
    private readonly getUseCase: GetAdminAccountUseCase,
  ) {}

  // As duas rotas literais vêm antes de `:id` — o Nest casa na ordem.
  @Get('customers')
  @ApiOperation({
    summary: 'Listar clientes por participação em organização',
    description:
      'Exige `users:read`. Uma linha por (conta × organização): a mesma pessoa em duas organizações aparece duas vezes.',
  })
  @ApiOkResponse({ type: AdminCustomersPageDto })
  customers(
    @Query() query: ListAdminCustomersQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.customersUseCase.execute(query, user.id);
  }

  @Get('operators')
  @ApiOperation({
    summary: 'Listar operadores da plataforma',
    description:
      'Exige `users:read`. `permission` filtra pelos papéis que têm aquela permissão, resolvidos pela matriz do servidor.',
  })
  @ApiOkResponse({ type: AdminOperatorsPageDto })
  operators(
    @Query() query: ListAdminOperatorsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.operatorsUseCase.execute(query, user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalhar uma conta (cliente ou operador)',
    description: 'Exige `users:read`. Inclui dados de contato e participações.',
  })
  @ApiOkResponse({ type: AdminAccountDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Account) {
    return this.getUseCase.execute(id, user.id);
  }
}

@ApiTags('Admin - Cobrança')
@ApiBearerAuth()
@Controller('/api/v1/admin')
export class AdminBillingReadController {
  constructor(
    private readonly subscriptionsUseCase: ListAdminSubscriptionsUseCase,
    private readonly invoicesUseCase: ListAdminInvoicesUseCase,
  ) {}

  @Get('subscriptions')
  @ApiOperation({
    summary: 'Listar assinaturas de organização (cross-org)',
    description: 'Exige `subscriptions:read`.',
  })
  @ApiOkResponse({ type: AdminSubscriptionsPageDto })
  subscriptions(
    @Query() query: ListAdminSubscriptionsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.subscriptionsUseCase.execute(query, user.id);
  }

  @Get('invoices')
  @ApiOperation({
    summary: 'Listar faturas (assinatura e contrato)',
    description:
      'Exige `billing:read`. `overdue=true` recorta as pendentes com vencimento no passado.',
  })
  @ApiOkResponse({ type: AdminInvoicesPageDto })
  invoices(
    @Query() query: ListAdminInvoicesQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.invoicesUseCase.execute(query, user.id);
  }
}

@ApiTags('Admin - Plataforma')
@ApiBearerAuth()
@Controller('/api/v1/admin')
export class AdminPlatformReadController {
  constructor(
    private readonly integrationsUseCase: ListAdminIntegrationsUseCase,
    private readonly jobRunsUseCase: ListAdminJobRunsUseCase,
    private readonly auditUseCase: ListAdminAuditLogsUseCase,
    private readonly overviewUseCase: GetAdminOverviewUseCase,
  ) {}

  @Get('integrations')
  @ApiOperation({
    summary: 'Listar credenciais de integração (cross-org)',
    description:
      'Exige `integrations:read`. Com as contas de anúncio de cada credencial. Nenhum token na resposta.',
  })
  @ApiOkResponse({ type: AdminIntegrationsPageDto })
  integrations(
    @Query() query: ListAdminIntegrationsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.integrationsUseCase.execute(query, user.id);
  }

  @Get('job-runs')
  @ApiOperation({
    summary: 'Listar execuções de job',
    description:
      'Exige `operations:read`. `stalled=true` recorta as `RUNNING` com lease vencido.',
  })
  @ApiOkResponse({ type: AdminJobRunsPageDto })
  jobRuns(
    @Query() query: ListAdminJobRunsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.jobRunsUseCase.execute(query, user.id);
  }

  @Get('audit-logs')
  @ApiOperation({
    summary: 'Trilha de auditoria (negócio + segurança)',
    description:
      'Exige `audit:read`. As duas tabelas numa lista só, mais nova primeiro.',
  })
  @ApiOkResponse({ type: AdminAuditEventsPageDto })
  auditLogs(
    @Query() query: ListAdminAuditLogsQueryDto,
    @CurrentUser() user: Account,
  ) {
    return this.auditUseCase.execute(query, user.id);
  }

  @Get('overview')
  @ApiOperation({
    summary: 'Números do Dashboard, filtrados pelas áreas do operador',
    description:
      'Exige `dashboard:read`. Só volta a métrica cuja permissão o operador tem; `value: null` = indisponível agora.',
  })
  @ApiOkResponse({ type: AdminOverviewDto })
  overview(@CurrentUser() user: Account) {
    return this.overviewUseCase.execute(user.id);
  }
}
