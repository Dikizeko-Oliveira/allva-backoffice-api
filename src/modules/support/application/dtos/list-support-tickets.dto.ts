import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SupportTicketCategory,
  SupportTicketCategoryValues,
  SupportTicketPriority,
  SupportTicketPriorityValues,
  SupportTicketStatus,
  SupportTicketStatusValues,
} from 'src/modules/support/domain/entities';
import { SanitizeText } from '../validators/sanitize.transform';

export class ListSupportTicketsQueryDto {
  @ApiProperty({ enum: SupportTicketStatusValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketStatusValues, {
    message: `Status must be one of: ${SupportTicketStatusValues.join(', ')}`,
  })
  status?: SupportTicketStatus;

  @ApiProperty({ enum: SupportTicketCategoryValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketCategoryValues, {
    message: `Category must be one of: ${SupportTicketCategoryValues.join(', ')}`,
  })
  category?: SupportTicketCategory;

  @ApiProperty({ enum: SupportTicketPriorityValues, required: false })
  @IsOptional()
  @IsIn(SupportTicketPriorityValues, {
    message: `Priority must be one of: ${SupportTicketPriorityValues.join(', ')}`,
  })
  priority?: SupportTicketPriority;

  @ApiProperty({
    required: false,
    description: 'Busca por código ou assunto, sem diferenciar maiúsculas.',
  })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'search must be a string' })
  @MaxLength(200, { message: 'search must have at most 200 characters' })
  search?: string;

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
