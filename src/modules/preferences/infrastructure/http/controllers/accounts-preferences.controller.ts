import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import {
  CreatePreferenceInputDto,
  CreatePreferenceOutputDto,
  ListPreferenceOutputDto,
  UpdatePreferenceInputDto,
  UpdatePreferenceOutputDto,
} from 'src/modules/preferences/application/dtos';
import {
  CreatePreferenceUseCase,
  ListPreferenceUseCase,
  UpdatePreferenceUseCase,
} from 'src/modules/preferences/application/use-cases';

@ApiTags('Gerenciar Preferências')
@Controller('/api/v1/accounts/preferences')
@UseGuards(EntitlementGuard)
@AuthenticatedOnly()
export class AccountsPreferencesController {
  constructor(
    private readonly createPreferenceUseCase: CreatePreferenceUseCase,
    private readonly updatePreferenceUseCase: UpdatePreferenceUseCase,
    private readonly listPreferenceUseCase: ListPreferenceUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Criar preferências da conta' })
  async createPreference(
    @Body() dto: CreatePreferenceInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreatePreferenceOutputDto> {
    return this.createPreferenceUseCase.execute(dto, user.id);
  }

  @Put()
  @ApiOperation({ summary: 'Atualizar preferências da conta' })
  async updatePreference(
    @Body() dto: UpdatePreferenceInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdatePreferenceOutputDto> {
    return this.updatePreferenceUseCase.execute(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Consultar preferências da conta' })
  async listPreference(
    @CurrentUser() user: Account,
  ): Promise<ListPreferenceOutputDto> {
    return this.listPreferenceUseCase.execute(user.id);
  }
}
