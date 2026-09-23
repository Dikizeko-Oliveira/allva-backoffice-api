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
import { ThrottleLimit } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  ContactOutputDto,
  CreateContactInputDto,
  CreateContactOutputDto,
  ListContactsOutputDto,
  ListContactsQueryDto,
  UpdateContactStatusInputDto,
  UpdateContactStatusOutputDto,
} from '../../../application/dtos';
import {
  CreateContactUseCase,
  GetContactUseCase,
  ListContactsUseCase,
  UpdateContactStatusUseCase,
} from '../../../application/use-cases';

type AuthenticatedUser = { id: string; email: string } | undefined;
type OperatorUser = { id: string; email: string };

@ApiTags('Contacts')
@Controller('/api/v1/contacts')
export class ContactsController {
  constructor(
    private readonly createContactUseCase: CreateContactUseCase,
    private readonly listContactsUseCase: ListContactsUseCase,
    private readonly getContactUseCase: GetContactUseCase,
    private readonly updateContactStatusUseCase: UpdateContactStatusUseCase,
  ) {}

  @Post()
  @Public()
  @ThrottleLimit(5)
  @ApiOperation({
    summary:
      'Criar contato (público). Se autenticado, o account_id é associado pelo backend via JWT.',
  })
  @ApiCreatedResponse({ type: CreateContactOutputDto })
  async create(
    @Body() dto: CreateContactInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreateContactOutputDto> {
    // account_id is resolved from the authenticated session only — never trusted
    // from the request body.
    const accountId = user?.id ?? null;
    return this.createContactUseCase.execute(dto, accountId);
  }

  /**
   * As três leituras e escritas da caixa de entrada — **só operador**.
   *
   * Eram só "autenticadas", e autenticado aqui quer dizer qualquer cliente
   * logado: ele listava a caixa de fale-conosco inteira da Allva — nome,
   * e-mail, empresa e mensagem de cada visitante, inclusive prospects de
   * concorrentes — e mudava o status de qualquer uma. É o B11 do mapa de
   * endpoints do backoffice, que pedia a correção antes de a tela apontar
   * para a API de verdade.
   *
   * O caminho não mudou para não quebrar quem já chama. A autorização mora
   * no use case, como nas outras superfícies administrativas.
   */
  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Listar contatos',
    description: 'Exige a permissão de plataforma `contacts:read`.',
  })
  @ApiOkResponse({ type: ListContactsOutputDto })
  async list(
    @Query() query: ListContactsQueryDto,
    @CurrentUser() user: OperatorUser,
  ): Promise<ListContactsOutputDto> {
    return this.listContactsUseCase.execute(query, user.id);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Obter contato por ID',
    description: 'Exige a permissão de plataforma `contacts:read`.',
  })
  @ApiOkResponse({ type: ContactOutputDto })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: OperatorUser,
  ): Promise<ContactOutputDto> {
    return this.getContactUseCase.execute(id, user.id);
  }

  @Patch(':id/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Atualizar status do contato',
    description: 'Exige a permissão de plataforma `contacts:manage`.',
  })
  @ApiOkResponse({ type: UpdateContactStatusOutputDto })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateContactStatusInputDto,
    @CurrentUser() user: OperatorUser,
  ): Promise<UpdateContactStatusOutputDto> {
    return this.updateContactStatusUseCase.execute(id, dto, user.id);
  }
}
