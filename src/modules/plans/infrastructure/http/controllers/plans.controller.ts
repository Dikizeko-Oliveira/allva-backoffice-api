import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import {
  CreatePlanUseCase,
  ListPlansUseCase,
} from 'src/modules/plans/application/use-cases';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import {
  CreatePlanInputDto,
  CreatePlanOutputDto,
  ListPlansItemOutputDto,
} from 'src/modules/plans/application/dtos';

@ApiTags('Gerenciar Planos')
@Controller('/api/v1/plans')
export class PlansController {
  constructor(
    private readonly listPlansUseCase: ListPlansUseCase,
    private readonly createPlanUseCase: CreatePlanUseCase,
  ) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Listar planos' })
  @ApiOkResponse({ type: [ListPlansItemOutputDto] })
  async listPlans(): Promise<ListPlansItemOutputDto[]> {
    const plans = await this.listPlansUseCase.execute();

    return plans.map((plan) => plan.toJSON());
  }

  @Post()
  @ApiOperation({ summary: 'Criar plano' })
  @ApiBody({ type: CreatePlanInputDto })
  @ApiCreatedResponse({ type: CreatePlanOutputDto })
  async createPlan(
    @Body() dto: CreatePlanInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreatePlanOutputDto> {
    const accountId = user.id;

    return this.createPlanUseCase.execute(dto, accountId);
  }
}
