import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SalesLeadStatusValues } from '../../domain/entities';

enum SalesLeadStatusFilter {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  PROPOSAL_SENT = 'PROPOSAL_SENT',
  NEGOTIATION = 'NEGOTIATION',
  CLOSED_WON = 'CLOSED_WON',
  CLOSED_LOST = 'CLOSED_LOST',
}

export class ListSalesLeadsQueryDto {
  @ApiProperty({
    enum: SalesLeadStatusFilter,
    required: false,
    description: 'Filter leads by pipeline status',
  })
  @IsOptional()
  @IsEnum(SalesLeadStatusFilter, {
    message: `Status must be one of: ${SalesLeadStatusValues.join(', ')}`,
  })
  status?: SalesLeadStatusFilter;

  @ApiProperty({
    required: false,
    description: 'Filter by assignee identifier',
  })
  @IsOptional()
  @IsString({ message: 'assignedTo must be a string' })
  assignedTo?: string;

  @ApiProperty({
    required: false,
    description: 'Busca por empresa, contato ou e-mail.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiProperty({ required: false, description: 'Origem exata do lead.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  source?: string;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdTo?: Date;

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

export class SalesLeadOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  accountId: string | null;

  @ApiProperty()
  companyName: string;

  @ApiProperty()
  workEmail: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ nullable: true })
  phone: string | null;

  @ApiProperty({ nullable: true })
  estimatedMonthlySpend: number | null;

  @ApiProperty({ nullable: true })
  teamSize: number | null;

  @ApiProperty({ nullable: true, type: [String] })
  platforms: string[] | null;

  @ApiProperty({ nullable: true })
  notes: string | null;

  @ApiProperty()
  desiredPlan: string;

  @ApiProperty()
  status: string;

  @ApiProperty({ nullable: true })
  source: string | null;

  @ApiProperty({ nullable: true })
  assignedTo: string | null;

  @ApiProperty({ nullable: true })
  qualifiedAt: Date | null;

  @ApiProperty({ nullable: true })
  closedWonAt: Date | null;

  @ApiProperty({ nullable: true })
  closedLostAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    nullable: true,
    description:
      'A organização criada pela ativação do contrato deste lead. Nulo até lá.',
  })
  provisionedOrganizationId: string | null;
}

export class ListSalesLeadsOutputDto {
  @ApiProperty({ type: [SalesLeadOutputDto] })
  items: SalesLeadOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
