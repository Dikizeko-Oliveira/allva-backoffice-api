import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { FINDING_TYPES } from 'src/modules/waste/domain/contracts/finding-catalog';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

const FINDING_KINDS = ['WASTE', 'OPPORTUNITY'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const MATURITIES = ['IMMATURE', 'SETTLING', 'MATURE'] as const;
const STATES = ['open', 'resolved', 'all'] as const;
const GROUP_BY = ['campaign', 'adSet', 'platform', 'adAccount'] as const;

/**
 * Os filtros de `/waste/items` (§7.3).
 *
 * **Não existe `level` aqui, e a ausência é a entrega.** No v1 o filtro era
 * obrigatório para não contar o mesmo gasto quatro vezes; com uma granularidade
 * só, ele deixou de ter o que filtrar — e mantê-lo seria convite a reintroduzir
 * a dupla contagem que a v2.0 existe para eliminar (G10).
 *
 * `findingKind` e `dataMaturity` entram no lugar: o primeiro separa desperdício
 * de oportunidade, o segundo diz se o dado por trás do achado já assentou.
 */
export class ListWasteItemsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: FINDING_KINDS, default: 'WASTE' })
  @IsOptional()
  @IsIn(FINDING_KINDS as unknown as string[])
  findingKind?: (typeof FINDING_KINDS)[number];

  @ApiPropertyOptional({ enum: FINDING_TYPES as unknown as string[] })
  @IsOptional()
  @IsIn(FINDING_TYPES as unknown as string[])
  type?: (typeof FINDING_TYPES)[number];

  @ApiPropertyOptional({ enum: PRIORITIES })
  @IsOptional()
  @IsIn(PRIORITIES as unknown as string[])
  priority?: (typeof PRIORITIES)[number];

  @ApiPropertyOptional({
    enum: MATURITIES,
    description:
      'Maturidade do dado que sustenta o achado (§8.9): `IMMATURE` ainda vai mudar.',
  })
  @IsOptional()
  @IsIn(MATURITIES as unknown as string[])
  dataMaturity?: (typeof MATURITIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adId?: string;

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

  @ApiPropertyOptional({ enum: STATES, default: 'open' })
  @IsOptional()
  @IsIn(STATES as unknown as string[])
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({
    description: 'Piso do que dá para interromper hoje, em moeda-base.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minAvoidableDailyBase?: number;
}

export class WasteRollupQueryDto {
  @ApiPropertyOptional({ enum: GROUP_BY, default: 'campaign' })
  @IsOptional()
  @IsIn(GROUP_BY as unknown as string[])
  groupBy?: (typeof GROUP_BY)[number];

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class WasteSummaryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adAccountId?: string;
}
