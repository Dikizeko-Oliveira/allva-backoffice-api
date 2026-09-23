import {
  Body,
  Controller,
  Delete,
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
  CreateSavedViewInputDto,
  DeleteSavedViewOutputDto,
  ListSavedViewsQueryDto,
  SavedViewOutputDto,
  UpdateSavedViewInputDto,
} from 'src/modules/preferences/application/dtos';
import {
  CreateSavedViewUseCase,
  DeleteSavedViewUseCase,
  ListSavedViewsUseCase,
  UpdateSavedViewUseCase,
} from 'src/modules/preferences/application/use-cases';

const SCREEN_DOC =
  'Exige a permissão de leitura da tela; tela que o operador não vê responde `404 SAVED_VIEW_SCREEN_NOT_AVAILABLE`.';

@ApiTags('Visões salvas')
@ApiBearerAuth()
@Controller('/api/v1/views')
export class SavedViewsController {
  constructor(
    private readonly listSavedViewsUseCase: ListSavedViewsUseCase,
    private readonly createSavedViewUseCase: CreateSavedViewUseCase,
    private readonly updateSavedViewUseCase: UpdateSavedViewUseCase,
    private readonly deleteSavedViewUseCase: DeleteSavedViewUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Minhas visões e as compartilhadas',
    description: SCREEN_DOC,
  })
  @ApiOkResponse({ type: [SavedViewOutputDto] })
  async list(
    @CurrentOperator() operator: Operator,
    @Query() query: ListSavedViewsQueryDto,
  ): Promise<SavedViewOutputDto[]> {
    return this.listSavedViewsUseCase.execute(operator, query);
  }

  @Post()
  @ApiOperation({ summary: 'Salvar visão', description: SCREEN_DOC })
  @ApiCreatedResponse({ type: SavedViewOutputDto })
  async create(
    @CurrentOperator() operator: Operator,
    @Body() dto: CreateSavedViewInputDto,
  ): Promise<SavedViewOutputDto> {
    return this.createSavedViewUseCase.execute(operator, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Alterar visão',
    description: `${SCREEN_DOC} Só o dono.`,
  })
  @ApiOkResponse({ type: SavedViewOutputDto })
  async update(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
    @Body() dto: UpdateSavedViewInputDto,
  ): Promise<SavedViewOutputDto> {
    return this.updateSavedViewUseCase.execute(operator, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Apagar visão',
    description: `${SCREEN_DOC} Só o dono.`,
  })
  @ApiOkResponse({ type: DeleteSavedViewOutputDto })
  async remove(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
  ): Promise<DeleteSavedViewOutputDto> {
    return this.deleteSavedViewUseCase.execute(operator, id);
  }
}
