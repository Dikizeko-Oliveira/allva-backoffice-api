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
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  ContractDraftOutputDto,
  CreateContractDraftInputDto,
  ListContractDraftsOutputDto,
  ListContractDraftsQueryDto,
  UpdateContractDraftInputDto,
} from 'src/modules/contract-drafts/application/dtos';
import {
  ConvertContractDraftUseCase,
  CreateContractDraftUseCase,
  GetContractDraftUseCase,
  ListContractDraftsUseCase,
  UpdateContractDraftUseCase,
} from 'src/modules/contract-drafts/application/use-cases';

@ApiTags('Minutas de contrato')
@ApiBearerAuth()
@Controller('/api/v1/contract-drafts')
export class ContractDraftsController {
  constructor(
    private readonly listContractDraftsUseCase: ListContractDraftsUseCase,
    private readonly getContractDraftUseCase: GetContractDraftUseCase,
    private readonly createContractDraftUseCase: CreateContractDraftUseCase,
    private readonly updateContractDraftUseCase: UpdateContractDraftUseCase,
    private readonly convertContractDraftUseCase: ConvertContractDraftUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar minutas',
    description: 'Exige `billing:read`.',
  })
  @ApiOkResponse({ type: ListContractDraftsOutputDto })
  async list(
    @CurrentOperator() operator: Operator,
    @Query() query: ListContractDraftsQueryDto,
  ): Promise<ListContractDraftsOutputDto> {
    return this.listContractDraftsUseCase.execute(operator, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalhar minuta',
    description: 'Exige `billing:read`.',
  })
  @ApiOkResponse({ type: ContractDraftOutputDto })
  async get(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
  ): Promise<ContractDraftOutputDto> {
    return this.getContractDraftUseCase.execute(operator, id);
  }

  @Post()
  @ApiOperation({
    summary: 'Criar minuta',
    description: 'Exige `billing:manage`.',
  })
  @ApiCreatedResponse({ type: ContractDraftOutputDto })
  async create(
    @CurrentOperator() operator: Operator,
    @Body() dto: CreateContractDraftInputDto,
  ): Promise<ContractDraftOutputDto> {
    return this.createContractDraftUseCase.execute(operator, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Alterar minuta',
    description:
      'Exige `billing:manage`. Minuta já convertida responde `409 CONTRACT_DRAFT_ALREADY_CONVERTED`.',
  })
  @ApiOkResponse({ type: ContractDraftOutputDto })
  async update(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
    @Body() dto: UpdateContractDraftInputDto,
  ): Promise<ContractDraftOutputDto> {
    return this.updateContractDraftUseCase.execute(operator, id, dto);
  }

  @Post(':id/convert')
  @ApiOperation({
    summary: 'Converter minuta em contrato no allva-api',
    description:
      'Exige `billing:manage` (aqui e no `allva-api`). Idempotente: minuta já convertida volta sem nova chamada ao produto.',
  })
  @ApiCreatedResponse({ type: ContractDraftOutputDto })
  async convert(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
  ): Promise<ContractDraftOutputDto> {
    return this.convertContractDraftUseCase.execute(operator, id);
  }
}
