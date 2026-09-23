import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  CreateOperatorInputDto,
  CreateOperatorOutputDto,
  UpdateCustomerMembershipStatusInputDto,
  UpdateCustomerMembershipStatusOutputDto,
  UpdateOperatorStatusInputDto,
  UpdateOperatorStatusOutputDto,
  UpdatePlatformRoleInputDto,
  UpdatePlatformRoleOutputDto,
} from 'src/modules/accounts/application/dtos';
import {
  CreateOperatorUseCase,
  UpdateCustomerMembershipStatusUseCase,
  UpdateOperatorStatusUseCase,
  UpdatePlatformRoleUseCase,
} from 'src/modules/accounts/application/use-cases';

/**
 * Contas vistas pela plataforma, sob `/admin`.
 *
 * Mesmo desenho das outras superfícies administrativas: autorização no use
 * case via `PlatformRoleService`, sem `EntitlementGuard` — operador não tem
 * assinatura. Por ora só a troca de papel (B3). Listagem de contas (B2),
 * status de operador (B18) e convite de operador (B19) são rotas irmãs que
 * ainda não existem.
 */
@ApiTags('Admin - Contas')
@ApiBearerAuth()
@Controller('/api/v1/admin/accounts')
export class AdminAccountsController {
  constructor(
    private readonly updatePlatformRoleUseCase: UpdatePlatformRoleUseCase,
    private readonly updateCustomerMembershipStatusUseCase: UpdateCustomerMembershipStatusUseCase,
    private readonly updateOperatorStatusUseCase: UpdateOperatorStatusUseCase,
    private readonly createOperatorUseCase: CreateOperatorUseCase,
  ) {}

  @Post('operators')
  @ApiOperation({
    summary: 'Cadastrar um operador de plataforma',
    description:
      'Exige `users:manage_platform_role`. Cria a conta com o papel informado e envia e-mail para a pessoa definir a própria senha.',
  })
  @ApiOkResponse({ type: CreateOperatorOutputDto })
  async createOperator(
    @Body() dto: CreateOperatorInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateOperatorOutputDto> {
    return this.createOperatorUseCase.execute(dto, user.id);
  }

  @Patch(':accountId/organizations/:organizationId/status')
  @ApiOperation({
    summary: 'Ativar ou bloquear um cliente em uma organização',
    description:
      'Exige `users:manage`. Atua sobre a participação do cliente na organização, preservando a proteção do último proprietário ativo.',
  })
  @ApiOkResponse({ type: UpdateCustomerMembershipStatusOutputDto })
  async updateCustomerMembershipStatus(
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateCustomerMembershipStatusInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdateCustomerMembershipStatusOutputDto> {
    return this.updateCustomerMembershipStatusUseCase.execute(
      accountId,
      organizationId,
      dto,
      user.id,
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Ativar ou suspender o acesso de um operador',
    description:
      'Exige `users:manage`. Suspender revoga as sessões ativas, sem apagar dados pessoais e sem trocar o papel de plataforma.',
  })
  @ApiOkResponse({ type: UpdateOperatorStatusOutputDto })
  async updateOperatorStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOperatorStatusInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdateOperatorStatusOutputDto> {
    return this.updateOperatorStatusUseCase.execute(id, dto, user.id);
  }

  @Patch(':id/platform-role')
  @ApiOperation({
    summary: 'Trocar o papel de plataforma de um operador',
    description:
      'Exige a permissão de plataforma `users:manage_platform_role` (só administração). ' +
      'O alvo precisa já ser operador — promover cliente é o convite de operador. ' +
      'Recusa rebaixar a última conta de administração (`LAST_PLATFORM_ADMIN`). ' +
      'Grava `account.platform_role.updated` na trilha.',
  })
  @ApiOkResponse({ type: UpdatePlatformRoleOutputDto })
  async updatePlatformRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformRoleInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdatePlatformRoleOutputDto> {
    return this.updatePlatformRoleUseCase.execute(id, dto, user.id);
  }
}
