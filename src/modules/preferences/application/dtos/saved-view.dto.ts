import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SAVED_VIEW_SCREENS } from 'src/modules/preferences/domain/screens';

export class ListSavedViewsQueryDto {
  @ApiProperty({ required: false, enum: SAVED_VIEW_SCREENS })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  screen?: string;
}

export class CreateSavedViewInputDto {
  @ApiProperty({ enum: SAVED_VIEW_SCREENS })
  @IsIn(SAVED_VIEW_SCREENS)
  screen: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ required: false, description: 'Opaco: o formato é da tela.' })
  @IsOptional()
  filters?: unknown;

  @ApiProperty({ required: false, description: 'Opaco: o formato é da tela.' })
  @IsOptional()
  columns?: unknown;

  @ApiProperty({ required: false, description: 'Opaco: o formato é da tela.' })
  @IsOptional()
  sort?: unknown;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

export class UpdateSavedViewInputDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  filters?: unknown;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  columns?: unknown;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  sort?: unknown;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  shared?: boolean;
}

export class SavedViewOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  operatorId: string;

  @ApiProperty()
  screen: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  filters: unknown;

  @ApiProperty()
  columns: unknown;

  @ApiProperty({ nullable: true })
  sort: unknown;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty()
  shared: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class DeleteSavedViewOutputDto {
  @ApiProperty({ example: true })
  deleted: true;
}
