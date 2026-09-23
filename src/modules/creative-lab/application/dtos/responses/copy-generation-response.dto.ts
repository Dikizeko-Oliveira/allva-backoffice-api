import { ApiProperty } from '@nestjs/swagger';

/**
 * `POST /ads/{id}/copy/generations` e as leituras do Copy Studio.
 *
 * A distinção que este contrato existe para carregar é **gerado × aplicável**:
 * cada campo de texto traz o veredito da plataforma sobre si, e é o que impede a
 * tela de oferecer "aplicar" num campo que nenhuma ação sabe escrever.
 */

export class CopyFieldDto {
  @ApiProperty({
    enum: ['primaryText', 'headline', 'description', 'callToAction'],
  })
  field!: string;

  @ApiProperty({ type: String, nullable: true })
  text!: string | null;

  @ApiProperty({ example: 118 })
  length!: number;

  @ApiProperty({
    description:
      'Existe ação que escreve este campo nesta plataforma. `false` **não** ' +
      'significa texto inútil: ele foi gerado para uso no gerenciador, e a ' +
      'tela deve dizer isso em vez de esconder o campo.',
  })
  applicable!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['REPLACE_COPY', 'REPLACE_CTA'],
    description: 'A ação que aplica este campo. A tela não adivinha qual é.',
  })
  appliedBy!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por que não é aplicável — declarado no `PlatformProfile`, nunca ' +
      'inventado pela tela (P7). Ex.: na Meta, a troca de texto recompõe o ' +
      'criativo sobrescrevendo apenas o texto principal.',
  })
  unavailableReason!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Acima disto a plataforma **recusa**. `null` = sem limite duro.',
  })
  maxLength!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Onde a plataforma corta na exibição. Passar daqui não quebra a chamada.',
  })
  recommendedLength!: number | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'O campo aceita **apenas** estes valores. Na Meta e no TikTok o CTA é ' +
      'enum, não prosa: uma frase ali é uma chamada que a plataforma recusa.',
  })
  allowedValues!: string[] | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'O texto cabe no campo desta plataforma. `null` quando não há texto. ' +
      'Marcado e **não corrigido**: aparar em silêncio publicaria um texto que ' +
      'ninguém escreveu.',
  })
  fitsPlatform!: boolean | null;

  @ApiProperty({ type: String, nullable: true })
  fitReason!: string | null;
}

export class CopyVariantDto {
  @ApiProperty()
  variantId!: string;

  @ApiProperty({
    enum: ['BENEFIT', 'PAIN', 'OUTCOME', 'PROOF', 'URGENCY'],
    description:
      'A hipótese que a variação testa. Três ângulos, não três redações do ' +
      'mesmo texto — é a diferença entre testar e reescrever.',
  })
  angle!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A abertura. **Não é campo de plataforma nenhuma** — é a primeira linha ' +
      'do texto principal, e por isso fica fora de `fields`.',
  })
  hook!: string | null;

  @ApiProperty({ type: [CopyFieldDto] })
  fields!: CopyFieldDto[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      '"Por que a Allva recomenda esta versão". Cada ponto aponta para a ' +
      'sugestão que atende (`addressesSuggestion`); `null` ali significa que o ' +
      'ponto veio do modelo e **não** da análise — e a tela não deve creditá-lo ' +
      'à Allva.',
  })
  reasoning!: Record<string, unknown>;

  @ApiProperty()
  selected!: boolean;

  @ApiProperty({ type: String, nullable: true })
  appliedActionExecutionId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt!: string | null;
}

export class CopyQuotaDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Teto mensal do plano, ou o negociado em contrato.',
  })
  limit!: number | null;

  @ApiProperty()
  used!: number;

  @ApiProperty({ type: Number, nullable: true })
  remaining!: number | null;
}

export class CopyGenerationResultDto {
  @ApiProperty()
  generationId!: string;

  @ApiProperty()
  adId!: string;

  @ApiProperty({ enum: ['FROM_INSIGHT', 'IMPROVE', 'FROM_BRIEF'] })
  source!: string;

  @ApiProperty({ enum: ['COMPLETED', 'AI_UNAVAILABLE'] })
  status!: string;

  @ApiProperty({
    description:
      'A geração veio do banco sem nova chamada de IA — o mesmo contexto ' +
      'devolve a geração anterior. Sem este campo, quem pede duas vezes vê a ' +
      'mesma resposta e conclui que a segunda chamou a IA.',
  })
  reusedPreviousGeneration!: boolean;

  @ApiProperty({
    description:
      '**`variants: []` com isto é uma resposta, não um erro.** O contexto e ' +
      'as sugestões que originaram o pedido continuam gravados; o que faltou ' +
      'foi o texto. É a regra desta feature na superfície: o determinístico ' +
      'decide o que mudar e sobrevive à queda da IA; o LLM só escreve as ' +
      'palavras.',
  })
  aiUnavailable!: boolean;

  @ApiProperty({ type: [CopyVariantDto] })
  variants!: CopyVariantDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A análise concluiu que mexer no texto não é o remédio deste anúncio ' +
      '(§11.3, `AUDIENCE_MISMATCH`). Presente mesmo quando a geração acontece ' +
      'por briefing — quem pediu merece saber que a Allva discorda.',
  })
  suggestionsWithheld!: string | null;

  @ApiProperty({ type: CopyQuotaDto })
  quota!: CopyQuotaDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class CopyGenerationSummaryDto {
  @ApiProperty()
  generationId!: string;

  @ApiProperty({ enum: ['FROM_INSIGHT', 'IMPROVE', 'FROM_BRIEF'] })
  source!: string;

  @ApiProperty({ enum: ['COMPLETED', 'AI_UNAVAILABLE'] })
  status!: string;

  @ApiProperty()
  variantCount!: number;

  @ApiProperty({ type: String, nullable: true })
  selectedVariantId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appliedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  aiProvider!: string | null;

  @ApiProperty({ type: String, nullable: true })
  aiModel!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class CopyVariantSelectionDto {
  @ApiProperty()
  variantId!: string;

  @ApiProperty()
  selected!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  selectedAt!: string | null;
}
