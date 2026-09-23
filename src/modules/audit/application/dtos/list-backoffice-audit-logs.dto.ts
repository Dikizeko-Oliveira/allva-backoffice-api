import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

export class ListBackofficeAuditLogsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false, description: 'Id do operador que agiu.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorId?: string;

  @ApiProperty({ required: false, example: 'support.ticket.assigned' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  subjectId?: string;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class BackofficeAuditLogOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    enum: ['BACKOFFICE'],
    description:
      'Sempre `BACKOFFICE`: a tela de auditoria junta esta trilha com a do `allva-api` e precisa saber de qual veio cada linha.',
  })
  source: 'BACKOFFICE';

  @ApiProperty()
  actorId: string;

  @ApiProperty()
  action: string;

  @ApiProperty()
  subjectType: string;

  @ApiProperty()
  subjectId: string;

  @ApiProperty({ nullable: true })
  before: unknown;

  @ApiProperty({ nullable: true })
  after: unknown;

  @ApiProperty({ nullable: true })
  reason: string | null;

  @ApiProperty({ nullable: true })
  ip: string | null;

  @ApiProperty({ nullable: true })
  userAgent: string | null;

  @ApiProperty()
  createdAt: Date;
}

export class ListBackofficeAuditLogsOutputDto {
  @ApiProperty({ type: [BackofficeAuditLogOutputDto] })
  items: BackofficeAuditLogOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
