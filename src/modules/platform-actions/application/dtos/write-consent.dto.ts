import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn } from 'class-validator';
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

export class GrantWriteConsentDto {
  /**
   * **Lista explícita, sem atalho para "todos".**
   *
   * Um `all: true` seria mais cômodo e é exatamente o que o consentimento
   * existe para não permitir: quem autoriza precisa ver o que está autorizando,
   * e "pausar anúncios" e "mexer no orçamento" não podem caber no mesmo clique
   * distraído.
   */
  @ApiProperty({ enum: ACTION_TYPES, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ACTION_TYPES, { each: true })
  consentedActionTypes!: AdActionType[];
}

export class ToggleKillSwitchDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
