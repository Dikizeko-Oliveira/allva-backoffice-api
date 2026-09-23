import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RECOMMENDATION_KINDS } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

const STATUSES = [
  'NEW',
  'ACKNOWLEDGED',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'DISMISSED',
  'EXPIRED',
  'SUPERSEDED',
  'DEFERRED_BY_CONFLICT',
] as const;

const SCOPES = ['AD', 'AD_SET', 'CAMPAIGN', 'ORGANIZATION'] as const;

/** `?flag=true` chega como string; sem isto, `'false'` seria verdadeiro. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === undefined ? undefined : value === 'true' || value === true;

export class ListRecommendationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: STATUSES, default: 'NEW' })
  @IsOptional()
  @IsIn(STATUSES as unknown as string[])
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: RECOMMENDATION_KINDS as unknown as string[] })
  @IsOptional()
  @IsIn(RECOMMENDATION_KINDS as unknown as string[])
  kind?: (typeof RECOMMENDATION_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adId?: string;

  @ApiPropertyOptional({
    description:
      'Consultivas nunca entram nas métricas de acurácia de P8; filtrar por elas é ' +
      'o que permite ler as duas populações separadas.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  advisory?: boolean;

  @ApiPropertyOptional({
    description:
      '`true` devolve só as retidas por guarda, com `blockedReason` visível.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  blocked?: boolean;
}

/**
 * `POST /recommendations/{id}/dismiss` — **cria uma supressão** (§9.4 passo 3d).
 *
 * Dispensar não é esconder uma linha: é dizer ao motor que este remédio não
 * serve neste escopo, por um prazo. Sem a supressão, a geração de amanhã
 * reapresenta o mesmo plano — e um motor que não escuta morre por isso, não por
 * errar.
 */
export class DismissRecommendationDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    enum: SCOPES,
    default: 'AD',
    description:
      'Padrão `AD`: dispensar é "não neste anúncio", não "nunca mais na conta".',
  })
  @IsOptional()
  @IsIn(SCOPES as unknown as string[])
  scope?: (typeof SCOPES)[number];

  @ApiPropertyOptional({
    description: 'Dias de silêncio. Ausente usa o padrão; `0` = permanente.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  days?: number;
}

/**
 * `POST /recommendations/{id}/apply`.
 *
 * `dryRun` ausente **é dry-run**, e não o contrário. Assumir escrita real por
 * omissão faria um cliente desatualizado mover dinheiro por não ter mandado um
 * campo — a mesma decisão que `POST /ads/{id}/actions` tomou em A2-S7, pela
 * mesma razão.
 */
export class ApplyRecommendationDto {
  @ApiPropertyOptional({
    default: true,
    description:
      '`false` executa o plano de verdade, sujeito a PLATFORM_ACTIONS_DRY_RUN_ONLY.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  dryRun?: boolean;

  /**
   * R14 — o dígito do texto confirmado, por ação que publica conteúdo autoral.
   *
   * Mapa `actionId → digest` e não um campo só: um plano pode trocar copy **e**
   * CTA, e um dígito único não distinguiria qual texto o usuário leu. A guarda
   * de A2-S7 exige o dígito **do conteúdo**, e um booleano continuaria
   * verdadeiro depois de o texto ser regenerado.
   */
  @ApiPropertyOptional({
    type: Object,
    description: 'Mapa actionId → dígito do conteúdo confirmado (R14).',
  })
  @IsOptional()
  @IsObject()
  confirmedContentDigests?: Record<string, string>;
}
