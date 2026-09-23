import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * `14d` existe para casar com a **janela de análise** padrão da organização.
 *
 * Os totais desta tela são somas de `ad_metric_snapshots` no período pedido, e
 * o diagnóstico (score, desperdício) é calculado sobre a janela da organização —
 * são perguntas diferentes e podem ter períodos diferentes. Sem um `14d` aqui,
 * porém, não havia como olhar as duas no mesmo intervalo, que é exatamente a
 * comparação que alguém faz ao estranhar um número.
 */
const PERIODS = ['7d', '14d', '30d', '90d'] as const;
export type AnalyticsPeriod = (typeof PERIODS)[number];

const PERIOD_DAYS: Readonly<Record<AnalyticsPeriod, number>> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = '30d';

const PLATFORMS = ['META', 'GOOGLE', 'TIKTOK'] as const;
const ATTRIBUTIONS = ['last-click', 'linear', 'blended-attribution'] as const;
export type AttributionModel = (typeof ATTRIBUTIONS)[number];

export class AnalyticsQueryDto {
  @ApiProperty({ enum: PERIODS, required: false, default: '30d' })
  @IsOptional()
  @IsIn(PERIODS as unknown as string[])
  period?: AnalyticsPeriod = '30d';

  @ApiProperty({ required: false, isArray: true, enum: PLATFORMS })
  @IsOptional()
  @Transform(({ value }): string[] => {
    if (typeof value === 'string')
      return value.split(',').map((s: string) => s.trim().toUpperCase());
    if (Array.isArray(value)) return value as string[];
    return [];
  })
  @IsArray()
  @IsIn(PLATFORMS as unknown as string[], { each: true })
  platforms?: Array<'META' | 'GOOGLE' | 'TIKTOK'>;

  @ApiProperty({
    enum: ATTRIBUTIONS,
    required: false,
    description:
      'Como dividir a receita observada entre plataformas. **Nenhuma opção é ' +
      'atribuição entre pontos de contato.** `last-click` (nome legado) = ' +
      'receita como cada plataforma reporta; `linear` = receita total pela ' +
      'fatia de investimento; `blended-attribution` = metade reportada, ' +
      'metade pela fatia de investimento. Em qualquer opção a soma é a ' +
      'receita total observada, em moeda-base.',
  })
  @IsOptional()
  @IsString()
  @IsIn(ATTRIBUTIONS as unknown as string[])
  attribution?: AttributionModel;
}

/**
 * Mapa em vez de cadeia de `if`: a versão anterior devolvia 30 para tudo que
 * não fosse `7d` nem `90d`, então um período novo nascia silenciosamente
 * valendo 30 dias — `14d` teria entrado no enum, passado a validação e
 * consultado um mês.
 */
export function periodToDays(period: AnalyticsPeriod | undefined): number {
  return PERIOD_DAYS[period ?? DEFAULT_ANALYTICS_PERIOD];
}
