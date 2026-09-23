import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * O corpo de `POST /ads/{id}/copy/generations`.
 *
 * **Três perguntas e um campo livre — e é o desenho, não a versão reduzida.**
 * Tudo o mais que o prompt precisa a Allva já sabe: campanha, plataforma,
 * objetivo declarado, público, copy atual, score, análise e sugestão. Pedir ao
 * usuário o que a plataforma já tem é o que transforma a feature num formulário
 * de gerador genérico.
 */
export class GenerateCopyDto {
  @ApiProperty({
    enum: ['FROM_INSIGHT', 'IMPROVE', 'FROM_BRIEF'],
    description:
      '`FROM_INSIGHT` transforma a sugestão da análise em texto — é a origem ' +
      'que dá autoridade à variação, e ela **recusa** quando não há sugestão, ' +
      'em vez de virar um briefing silenciosamente. `IMPROVE` parte da copy no ' +
      'ar preservando a oferta. `FROM_BRIEF` recomeça, e ainda assim exige um ' +
      'anúncio: geração sem anúncio não é mensurável nem aplicável (P1).',
  })
  @IsIn(['FROM_INSIGHT', 'IMPROVE', 'FROM_BRIEF'])
  source!: 'FROM_INSIGHT' | 'IMPROVE' | 'FROM_BRIEF';

  @ApiProperty({ enum: ['CONVERSION', 'LEADS', 'TRAFFIC', 'AWARENESS'] })
  @IsIn(['CONVERSION', 'LEADS', 'TRAFFIC', 'AWARENESS'])
  objective!: 'CONVERSION' | 'LEADS' | 'TRAFFIC' | 'AWARENESS';

  @ApiProperty({
    enum: ['PROFESSIONAL', 'DIRECT', 'PERSUASIVE', 'CASUAL', 'EDUCATIONAL'],
  })
  @IsIn(['PROFESSIONAL', 'DIRECT', 'PERSUASIVE', 'CASUAL', 'EDUCATIONAL'])
  tone!: 'PROFESSIONAL' | 'DIRECT' | 'PERSUASIVE' | 'CASUAL' | 'EDUCATIONAL';

  @ApiProperty({
    enum: [
      'BENEFIT',
      'PAIN',
      'OFFER',
      'SOCIAL_PROOF',
      'URGENCY',
      'DIFFERENTIATION',
    ],
  })
  @IsIn([
    'BENEFIT',
    'PAIN',
    'OFFER',
    'SOCIAL_PROOF',
    'URGENCY',
    'DIFFERENTIATION',
  ])
  focus!:
    | 'BENEFIT'
    | 'PAIN'
    | 'OFFER'
    | 'SOCIAL_PROOF'
    | 'URGENCY'
    | 'DIFFERENTIATION';

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'O único campo livre. Opcional por desenho.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  extraInstructions?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Ignora a geração equivalente mais recente e chama a IA de novo. ' +
      'Sem isto, um pedido com o mesmo contexto devolve a geração anterior — o ' +
      'que cobre o duplo-clique e quem reabre a tela. **Não é P9**: o modelo ' +
      'escreve outro texto a cada chamada, e regerar é pedido legítimo; o que ' +
      'este campo faz é torná-lo explícito, e ele consome a cota do mês.',
  })
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}
