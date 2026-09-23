import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { SYNC_BATCH_MAX_ADS } from '../use-cases/sync-ads-batch.usecase';

export class SyncAdsBatchDto {
  @ApiProperty({
    type: [String],
    description:
      'Ids dos anúncios a atualizar. São coalescidos por conta numa chamada só.',
    maxItems: SYNC_BATCH_MAX_ADS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYNC_BATCH_MAX_ADS)
  @IsUUID('4', { each: true })
  adIds!: string[];
}
