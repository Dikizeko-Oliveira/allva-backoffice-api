import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';

export class SupportMetricsQueryDto {
  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  operatorId?: string;
}

export class DurationPercentilesDto {
  @ApiProperty({ type: Number, nullable: true })
  medianMinutes: number | null;

  @ApiProperty({ type: Number, nullable: true })
  p90Minutes: number | null;
}

export class SupportVolumeDto {
  @ApiProperty()
  assigned: number;

  @ApiProperty({ type: Number, nullable: true })
  resolved: number | null;

  @ApiProperty({ type: Number, nullable: true })
  reopened: number | null;
}

/**
 * `null` = a métrica ainda não é medida, não "zero". Mediana e p90 de resposta
 * e resolução dependem de um histórico por mensagem que o backoffice-api ainda
 * não guarda.
 */
export class SupportMetricsOutputDto {
  @ApiProperty({ type: DurationPercentilesDto })
  firstResponse: DurationPercentilesDto;

  @ApiProperty({ type: DurationPercentilesDto })
  resolution: DurationPercentilesDto;

  @ApiProperty({ type: SupportVolumeDto })
  volume: SupportVolumeDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Percentual dentro do prazo de resolução. Nulo sem chamados no período.',
  })
  withinSlaPercentage: number | null;
}
