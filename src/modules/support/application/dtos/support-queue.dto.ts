import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SLA_STATES, type SlaState } from 'src/modules/support/domain/sla';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

/**
 * Os filtros da fila, repassados ao `allva-api`. A validação de vocabulário
 * (status, prioridade, categoria, uuid) é **do produto** — repetir os enums aqui
 * faria o backoffice-api recusar um status novo que o produto já aceita.
 */
export class ListSupportQueueQueryDto extends PageQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiProperty({ required: false, example: 'OPEN' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @ApiProperty({ required: false, example: 'HIGH' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  priority?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiProperty({ required: false, format: 'uuid' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  organizationId?: string;

  @ApiProperty({
    required: false,
    description: 'Id do operador, ou `none` para os chamados sem responsável.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  assignee?: string;
}

export class SupportTicketSlaDto {
  @ApiProperty({ enum: SLA_STATES })
  state: SlaState;

  @ApiProperty({ nullable: true })
  dueFirstResponseAt: Date | null;

  @ApiProperty({ nullable: true })
  dueResolutionAt: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'O prazo pendente mais próximo. Nulo quando nada está pendente.',
  })
  nextDueAt: Date | null;

  @ApiProperty({ nullable: true })
  firstOperatorReplyAt: Date | null;
}

export class SupportTicketEscalationDto {
  @ApiProperty({ nullable: true })
  escalatedAt: Date | null;

  @ApiProperty({ nullable: true })
  escalatedTo: string | null;
}

/**
 * O chamado do `allva-api` **intacto**, mais `sla` e `escalation`. Os demais
 * campos são os de `AdminSupportTicketOutputDto` no produto.
 */
export class SupportTicketOutputDto {
  [key: string]: unknown;

  @ApiProperty({ type: SupportTicketSlaDto })
  sla: SupportTicketSlaDto;

  @ApiProperty({ type: SupportTicketEscalationDto })
  escalation: SupportTicketEscalationDto;
}

export class ListSupportQueueOutputDto {
  @ApiProperty({
    type: [SupportTicketOutputDto],
    description:
      'Ordenados por risco de SLA dentro da página: estourado, em risco, no prazo.',
  })
  items: SupportTicketOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
