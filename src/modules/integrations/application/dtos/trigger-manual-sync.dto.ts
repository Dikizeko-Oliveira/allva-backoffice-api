import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { MetricLevel } from 'src/modules/integrations/domain/ports';

const LEVELS = ['CAMPAIGN', 'ADSET', 'AD', 'CREATIVE'] as const;

export class TriggerManualSyncInputDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  adAccountId?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: 90 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  lookbackDays?: number;

  @ApiProperty({ required: false, isArray: true, enum: LEVELS })
  @IsOptional()
  @IsArray()
  @IsIn(LEVELS as unknown as string[], { each: true })
  levels?: MetricLevel[];
}

export class TriggerManualSyncResponseDto {
  @ApiProperty()
  status!: 'ACCEPTED';

  @ApiProperty({ type: 'array' })
  jobs!: Array<{ adAccountId: string; jobId: string | null }>;

  @ApiProperty()
  triggeredAt!: Date;
}
