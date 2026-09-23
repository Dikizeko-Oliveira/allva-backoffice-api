import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateOperatorPreferenceInputDto {
  @ApiProperty({ required: false, nullable: true, example: 'support' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  lastWorkspace?: string | null;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  sidebarCollapsed?: boolean;

  @ApiProperty({ required: false, default: 'comfortable' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  density?: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 'America/Sao_Paulo',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  timezone?: string | null;
}

export class OperatorPreferenceOutputDto {
  @ApiProperty()
  operatorId: string;

  @ApiProperty({ nullable: true })
  lastWorkspace: string | null;

  @ApiProperty()
  sidebarCollapsed: boolean;

  @ApiProperty()
  density: string;

  @ApiProperty({ nullable: true })
  timezone: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Nulo enquanto o operador nunca salvou: os valores são os defaults.',
  })
  updatedAt: Date | null;
}
