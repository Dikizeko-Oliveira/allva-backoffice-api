import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { PLATFORM_VALUES } from 'src/modules/integrations/domain/entities/platform';
import {
  AD_SORT_FIELDS,
  AdSortField,
} from 'src/modules/ads/domain/ports/ads.repository';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

const AD_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'DELETED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'UNKNOWN',
] as const;

const SYNC_STATES = [
  'IN_SYNC',
  'PENDING_WRITE',
  'DRIFTED',
  'STALE',
  'UNREACHABLE',
] as const;

const MATURITIES = ['IMMATURE', 'SETTLING', 'MATURE'] as const;
const DIRECTIONS = ['asc', 'desc'] as const;

/** `?flag=true` chega como string; sem isto, `'false'` seria verdadeiro. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === 'true' || value === true;

/**
 * Os 16 filtros e as 5 ordenações de §7.1.
 *
 * Estende `PageQueryDto`, então cursor e limite (com teto de 100) vêm de graça e
 * são os mesmos de toda a superfície ads-first.
 */
export class ListAdsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PLATFORM_VALUES })
  @IsOptional()
  @IsIn(PLATFORM_VALUES as unknown as string[])
  platform?: (typeof PLATFORM_VALUES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  campaignId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adSetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  creativeId?: string;

  @ApiPropertyOptional({ enum: AD_STATUSES })
  @IsOptional()
  @IsIn(AD_STATUSES as unknown as string[])
  status?: (typeof AD_STATUSES)[number];

  @ApiPropertyOptional({ enum: SYNC_STATES })
  @IsOptional()
  @IsIn(SYNC_STATES as unknown as string[])
  syncState?: (typeof SYNC_STATES)[number];

  @ApiPropertyOptional({
    description: 'Padrão: false — a tela existe para o que ainda gasta.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasOpenWaste?: boolean;

  @ApiPropertyOptional({
    description:
      'Oportunidade é dinheiro que deixou de ser ganho, não gasto mal: nunca soma com desperdício.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasOpenOpportunity?: boolean;

  @ApiPropertyOptional({ description: 'Em moeda-base da organização (M1).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minWasteAmountBase?: number;

  @ApiPropertyOptional({
    description:
      'Aplica o piso de confiança de §12.4: quem está abaixo não entra, e o total excluído vem em meta.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  scoreBelow?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  scoreDroppedBy?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  confidenceAbove?: number;

  @ApiPropertyOptional({ enum: MATURITIES })
  @IsOptional()
  @IsIn(MATURITIES as unknown as string[])
  dataMaturity?: (typeof MATURITIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lineageId?: string;

  @ApiPropertyOptional({
    enum: AD_SORT_FIELDS,
    default: 'avoidableDaily',
    description:
      'Padrão `avoidableDaily`: rankeia pelo que dá para interromper hoje, não pelo que já se perdeu.',
  })
  @IsOptional()
  @IsIn(AD_SORT_FIELDS as unknown as string[])
  sortBy?: AdSortField;

  @ApiPropertyOptional({ enum: DIRECTIONS })
  @IsOptional()
  @IsIn(DIRECTIONS as unknown as string[])
  sortDirection?: 'asc' | 'desc';
}
