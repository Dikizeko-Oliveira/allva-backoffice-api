import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ContactStatusValues } from '../../domain/entities';

enum ContactStatusFilter {
  NEW = 'NEW',
  READ = 'READ',
  REPLIED = 'REPLIED',
  ARCHIVED = 'ARCHIVED',
}

export class ListContactsQueryDto {
  @ApiProperty({
    enum: ContactStatusFilter,
    required: false,
    description: 'Filter contacts by status',
  })
  @IsOptional()
  @IsEnum(ContactStatusFilter, {
    message: `Status must be one of: ${ContactStatusValues.join(', ')}`,
  })
  status?: ContactStatusFilter;

  @ApiProperty({
    required: false,
    type: String,
    format: 'date-time',
    description: 'Recebidos a partir desta data (inclusive).',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  createdFrom?: Date;

  @ApiProperty({
    required: false,
    type: String,
    format: 'date-time',
    description: 'Recebidos até esta data (inclusive).',
  })
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

export class ContactOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ nullable: true })
  accountId: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  subject: string;

  @ApiProperty()
  message: string;

  @ApiProperty({ nullable: true })
  company: string | null;

  @ApiProperty()
  status: string;

  @ApiProperty({ nullable: true })
  source: string | null;

  @ApiProperty({ nullable: true })
  readAt: Date | null;

  @ApiProperty({ nullable: true })
  repliedAt: Date | null;

  @ApiProperty({ nullable: true })
  archivedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class ListContactsOutputDto {
  @ApiProperty({ type: [ContactOutputDto] })
  items: ContactOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
