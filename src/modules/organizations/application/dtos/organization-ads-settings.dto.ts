import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import {
  MAX_SCORING_WINDOW_DAYS,
  MIN_SCORING_WINDOW_DAYS,
} from 'src/modules/organizations/domain/ports';

export class OrganizationAdsSettingsOutputDto {
  @ApiProperty({ example: 14 })
  scoringWindowDays!: number;

  @ApiProperty({ example: MIN_SCORING_WINDOW_DAYS })
  minScoringWindowDays!: number;

  @ApiProperty({ example: MAX_SCORING_WINDOW_DAYS })
  maxScoringWindowDays!: number;
}

export class UpdateOrganizationAdsSettingsInputDto {
  @ApiProperty({
    example: 30,
    minimum: MIN_SCORING_WINDOW_DAYS,
    maximum: MAX_SCORING_WINDOW_DAYS,
    description:
      'Janela de análise da organização, em dias. Vale para scoring, ' +
      'desperdício, Visão Geral e relatórios.',
  })
  @IsInt({ message: 'scoringWindowDays must be an integer' })
  @Min(MIN_SCORING_WINDOW_DAYS, {
    message: `scoringWindowDays must be at least ${MIN_SCORING_WINDOW_DAYS}`,
  })
  @Max(MAX_SCORING_WINDOW_DAYS, {
    message: `scoringWindowDays must be at most ${MAX_SCORING_WINDOW_DAYS}`,
  })
  scoringWindowDays!: number;
}
