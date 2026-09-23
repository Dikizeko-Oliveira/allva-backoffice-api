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
  CreateInternalNoteInputDto,
  DeleteInternalNoteOutputDto,
  InternalNoteOutputDto,
  ListInternalNotesQueryDto,
  UpdateInternalNoteInputDto,
} from 'src/modules/internal-notes/application/dtos';
import {
  CreateInternalNoteUseCase,
  DeleteInternalNoteUseCase,
  ListInternalNotesUseCase,
  UpdateInternalNoteUseCase,
} from 'src/modules/internal-notes/application/use-cases';

const SUBJECT_PERMISSIONS_DOC =
  'Exige a permissão de leitura do assunto: `orgs:read` (ORGANIZATION), `users:read` (ACCOUNT), `leads:read` (SALES_LEAD), `billing:read` (CONTRACT).';

@ApiTags('Notas internas')
@ApiBearerAuth()
@Controller('/api/v1/notes')
export class InternalNotesController {
  constructor(
    private readonly listInternalNotesUseCase: ListInternalNotesUseCase,
    private readonly createInternalNoteUseCase: CreateInternalNoteUseCase,
    private readonly updateInternalNoteUseCase: UpdateInternalNoteUseCase,
    private readonly deleteInternalNoteUseCase: DeleteInternalNoteUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Notas de um assunto',
    description: `${SUBJECT_PERMISSIONS_DOC} Notas com \`visibilityPermission\` que o operador não tem não aparecem.`,
  })
  @ApiOkResponse({ type: [InternalNoteOutputDto] })
  async list(
    @CurrentOperator() operator: Operator,
    @Query() query: ListInternalNotesQueryDto,
  ): Promise<InternalNoteOutputDto[]> {
    return this.listInternalNotesUseCase.execute(operator, query);
  }

  @Post()
  @ApiOperation({ summary: 'Anotar', description: SUBJECT_PERMISSIONS_DOC })
  @ApiCreatedResponse({ type: InternalNoteOutputDto })
  async create(
    @CurrentOperator() operator: Operator,
    @Body() dto: CreateInternalNoteInputDto,
  ): Promise<InternalNoteOutputDto> {
    return this.createInternalNoteUseCase.execute(operator, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Editar nota',
    description: `${SUBJECT_PERMISSIONS_DOC} Só o autor, ou quem tem \`settings:manage\`.`,
  })
  @ApiOkResponse({ type: InternalNoteOutputDto })
  async update(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
    @Body() dto: UpdateInternalNoteInputDto,
  ): Promise<InternalNoteOutputDto> {
    return this.updateInternalNoteUseCase.execute(operator, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Apagar nota',
    description: `${SUBJECT_PERMISSIONS_DOC} Só o autor, ou quem tem \`settings:manage\`. Apagamento lógico.`,
  })
  @ApiOkResponse({ type: DeleteInternalNoteOutputDto })
  async remove(
    @CurrentOperator() operator: Operator,
    @Param('id') id: string,
  ): Promise<DeleteInternalNoteOutputDto> {
    return this.deleteInternalNoteUseCase.execute(operator, id);
  }
}
