import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { MAX_BATCH_SIZE } from 'src/modules/platform-actions/domain/batch';

const ACTION_TYPES: AdActionType[] = [
  'PAUSE_AD',
  'ENABLE_AD',
  'ARCHIVE_AD',
  'DUPLICATE_AD',
  'REPLACE_CREATIVE',
  'REPLACE_COPY',
  'REPLACE_CTA',
  'PAUSE_AD_SET',
  'ENABLE_AD_SET',
  'ADJUST_AD_SET_BUDGET',
  'PAUSE_CAMPAIGN',
  'ENABLE_CAMPAIGN',
  'ADJUST_CAMPAIGN_BUDGET',
];

export class AdActionBatchItemDto {
  @ApiProperty()
  @IsString()
  adId!: string;

  @ApiProperty({ enum: ACTION_TYPES })
  @IsIn(ACTION_TYPES)
  type!: AdActionType;

  @ApiProperty({ type: Object })
  @IsObject()
  parameters!: Record<string, unknown>;
}

export class CreateAdActionBatchDto {
  /**
   * O teto de cem é de §13.5 e vive no domínio (`MAX_BATCH_SIZE`), não aqui.
   *
   * `class-validator` valida forma; a regra de blast radius é decisão de
   * produto, e precisa ser a mesma para qualquer caminho que venha a montar um
   * lote. Duplicá-la num decorador criaria dois números que divergiriam na
   * primeira vez que alguém mudasse um só.
   */
  @ApiProperty({ type: [AdActionBatchItemDto], maxItems: MAX_BATCH_SIZE })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => AdActionBatchItemDto)
  items!: AdActionBatchItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /**
   * §13.5 — acima de dez itens o dry-run **exige** `PLATFORM`. Só a plataforma
   * sabe dizer que este conjunto está sob CBO ou que aquele anúncio está em
   * revisão, e um dry-run local que aprova cem aprova exatamente o que ela vai
   * recusar.
   */
  @ApiPropertyOptional({ enum: ['LOCAL_ONLY', 'PLATFORM'] })
  @IsOptional()
  @IsIn(['LOCAL_ONLY', 'PLATFORM'])
  validationDepth?: 'LOCAL_ONLY' | 'PLATFORM';
}
