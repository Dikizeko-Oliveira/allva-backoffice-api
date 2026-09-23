import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';

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

export class CreateAdActionDto {
  @ApiProperty({ enum: ACTION_TYPES })
  @IsIn(ACTION_TYPES)
  type!: AdActionType;

  /**
   * Validado pelo schema **do tipo** (G15) na hora de persistir, não aqui.
   *
   * `class-validator` valida forma; o schema por tipo valida significado — que
   * `ADJUST_AD_SET_BUDGET` traz `dailyBudget` e `currency`, e que a moeda é a da
   * conta. Duplicar a segunda camada aqui criaria duas definições da mesma
   * regra, e a que erra é sempre a que ninguém atualiza.
   */
  @ApiProperty({ type: Object })
  @IsObject()
  parameters!: Record<string, unknown>;

  /**
   * Ausente, o default vem da instalação: com `PLATFORM_ACTIONS_DRY_RUN_ONLY`
   * ligada, **não pedir nada é pedir dry-run**. O contrário — assumir escrita
   * real por omissão — faria um cliente desatualizado mover dinheiro por não
   * ter mandado um campo.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /**
   * R14 — o dígito do texto que o usuário confirmou.
   *
   * Obrigatório em `REPLACE_COPY`/`REPLACE_CTA` com `aiAuthored: true`, e é o
   * **dígito do conteúdo**, não um booleano: um `confirmed: true` continuaria
   * verdadeiro depois de o texto ser regenerado, e o que iria ao ar não seria o
   * que alguém leu.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  confirmedContentDigest?: string;
}
