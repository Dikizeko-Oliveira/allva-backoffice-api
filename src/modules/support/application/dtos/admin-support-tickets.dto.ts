import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  SupportTicketCategory,
  SupportTicketCategoryValues,
  SupportTicketMessageKind,
  SupportTicketPriority,
  SupportTicketPriorityValues,
  SupportTicketStatus,
  SupportTicketStatusValues,
} from 'src/modules/support/domain/entities';
import { UNASSIGNED_FILTER } from 'src/modules/support/domain/ports';
import {
  SanitizeMultiline,
  SanitizeText,
} from '../validators/sanitize.transform';
import {
  SupportTicketStatusCountsDto,
  SupportTicketMessageDto,
} from './support-ticket.dto';

export class ListAdminSupportTicketsQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Código, assunto, e-mail ou nome do solicitante — sem diferenciar maiúsculas.',
  })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'search must be a string' })
  @MaxLength(200, { message: 'search must have at most 200 characters' })
  search?: string;

  @ApiProperty({ enum: SupportTicketStatusValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketStatusValues, {
    message: `Status must be one of: ${SupportTicketStatusValues.join(', ')}`,
  })
  status?: SupportTicketStatus;

  @ApiProperty({ enum: SupportTicketPriorityValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketPriorityValues, {
    message: `Priority must be one of: ${SupportTicketPriorityValues.join(', ')}`,
  })
  priority?: SupportTicketPriority;

  @ApiProperty({ enum: SupportTicketCategoryValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketCategoryValues, {
    message: `Category must be one of: ${SupportTicketCategoryValues.join(', ')}`,
  })
  category?: SupportTicketCategory;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsUUID('4', { message: 'organizationId must be a UUID' })
  organizationId?: string;

  @ApiProperty({
    required: false,
    description: `Id do operador, ou "${UNASSIGNED_FILTER}" para os chamados sem responsável.`,
  })
  @IsOptional()
  // O literal é um valor legítimo do filtro, então a validação de uuid só se
  // aplica ao outro caso. Sem isto, "sem responsável" seria recusado como id
  // malformado.
  @ValidateIf((_, value) => value !== UNASSIGNED_FILTER)
  @IsUUID('4', {
    message: `assignee must be a UUID or "${UNASSIGNED_FILTER}"`,
  })
  assignee?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer' })
  @Min(1, { message: 'page must be at least 1' })
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize must be an integer' })
  @Min(1, { message: 'pageSize must be at least 1' })
  @Max(100, { message: 'pageSize must be at most 100' })
  pageSize?: number = 20;
}

/**
 * A linha da fila do operador.
 *
 * Carrega nome da organização, plano e nome do responsável **resolvidos** —
 * pela mesma razão que o mapa de endpoints do backoffice registra em B1: sem
 * eles, cada linha da lista custaria três `GET` extras, e uma fila de vinte
 * viraria sessenta requisições.
 */
export class AdminSupportTicketOutputDto {
  @ApiProperty({ format: 'uuid', description: 'O id que a URL do painel usa.' })
  id: string;

  @ApiProperty({ example: 'SUP-20260908-7K4N' })
  code: string;

  @ApiProperty()
  subject: string;

  @ApiProperty({
    enum: ['SUPPORT'],
    description:
      'Sempre `SUPPORT`. **Não é coluna**: o painel modela também `CONTACT_FORM` (um fale-conosco escalado a chamado), e nada no `allva-api` produz esse valor hoje — não existe ação de escalar contato. O literal mantém a forma do contrato até existir produtor.',
  })
  channel: 'SUPPORT';

  @ApiProperty({ enum: SupportTicketStatusValues })
  status: SupportTicketStatus;

  @ApiProperty({ enum: SupportTicketPriorityValues })
  priority: SupportTicketPriority;

  @ApiProperty({ enum: SupportTicketCategoryValues })
  category: SupportTicketCategory;

  @ApiProperty()
  requesterName: string;

  @ApiProperty()
  requesterEmail: string;

  @ApiProperty({ format: 'uuid' })
  organizationId: string;

  @ApiProperty({ nullable: true })
  organizationName: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Plano vigente da organização — o contexto que tria a fila.',
  })
  planType: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  assigneeId: string | null;

  @ApiProperty({ nullable: true })
  assigneeName: string | null;

  @ApiProperty()
  hasAttachment: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    description:
      'Quando alguém falou pela última vez. Distinto de `updatedAt`: atribuir ou trocar status não é falar.',
  })
  lastMessageAt: Date;

  @ApiProperty({ nullable: true })
  resolvedAt: Date | null;
}

export class AdminSupportTicketDetailOutputDto extends AdminSupportTicketOutputDto {
  @ApiProperty({ description: 'O corpo do pedido original, como enviado.' })
  message: string;

  @ApiProperty({
    nullable: true,
    description:
      'URL de leitura assinada (uma hora). A permanente, gravada no banco, responde 403: o bucket é privado.',
  })
  attachmentUrl: string | null;

  @ApiProperty({ nullable: true })
  attachmentFilename: string | null;

  @ApiProperty({
    type: [SupportTicketMessageDto],
    description:
      'A conversa inteira, **incluindo `INTERNAL_NOTE`** — é a diferença entre esta rota e a do cliente.',
  })
  messages: SupportTicketMessageDto[];
}

export class ListAdminSupportTicketsOutputDto {
  @ApiProperty({ type: [AdminSupportTicketOutputDto] })
  items: AdminSupportTicketOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty({ type: SupportTicketStatusCountsDto })
  countsByStatus: SupportTicketStatusCountsDto;
}

/**
 * Os dois campos que o operador muda, numa requisição só.
 *
 * Juntos porque é assim que a tela funciona — pegar um chamado é atribuí-lo a
 * si e movê-lo para "em andamento" — e separar em dois `PATCH` deixaria a
 * fila num estado intermediário se o segundo falhasse. Ambos opcionais, e ao
 * menos um obrigatório (a recusa vem do use case).
 */
export class UpdateAdminSupportTicketInputDto {
  @ApiProperty({ enum: SupportTicketStatusValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketStatusValues, {
    message: `Status must be one of: ${SupportTicketStatusValues.join(', ')}`,
  })
  status?: SupportTicketStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    format: 'uuid',
    description:
      '`null` desatribui. Ausente não mexe no responsável — a distinção entre os dois é a razão de o campo ser nullable em vez de só opcional.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4', { message: 'assigneeId must be a UUID or null' })
  assigneeId?: string | null;
}

/** `CUSTOMER` não entra: esta porta é do operador. Ver o use case. */
const OPERATOR_MESSAGE_KINDS = ['OPERATOR', 'INTERNAL_NOTE'] as const;

export class CreateAdminSupportMessageInputDto {
  @ApiProperty({ enum: OPERATOR_MESSAGE_KINDS })
  @IsIn(OPERATOR_MESSAGE_KINDS, {
    message: `Kind must be one of: ${OPERATOR_MESSAGE_KINDS.join(', ')}`,
  })
  kind: Extract<SupportTicketMessageKind, 'OPERATOR' | 'INTERNAL_NOTE'>;

  @ApiProperty({ example: 'Revisamos a conexão e o token já foi renovado.' })
  @SanitizeMultiline()
  @IsString({ message: 'Body must be a string and is required' })
  @MinLength(2, { message: 'Body must have at least 2 characters' })
  @MaxLength(5000, { message: 'Body must have at most 5000 characters' })
  body: string;
}
