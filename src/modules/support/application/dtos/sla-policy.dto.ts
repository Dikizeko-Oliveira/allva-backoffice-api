import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Um mês. Meta maior que isso não é SLA, é backlog. */
const MAX_SLA_MINUTES = 30 * 24 * 60;

export class CreateSlaPolicyInputDto {
  @ApiProperty({ example: 'HIGH' })
  @IsString()
  @MaxLength(50)
  priority: string;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Nulo = vale para toda categoria da prioridade.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(50)
  category?: string | null;

  @ApiProperty({ example: 120 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MINUTES)
  firstResponseMinutes: number;

  @ApiProperty({ example: 1440 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SLA_MINUTES)
  resolutionMinutes: number;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  businessHours?: boolean;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateSlaPolicyInputDto extends PartialType(
  CreateSlaPolicyInputDto,
) {}

export class SlaPolicyOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  priority: string;

  @ApiProperty({ nullable: true })
  category: string | null;

  @ApiProperty()
  firstResponseMinutes: number;

  @ApiProperty()
  resolutionMinutes: number;

  @ApiProperty()
  businessHours: boolean;

  @ApiProperty()
  active: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
