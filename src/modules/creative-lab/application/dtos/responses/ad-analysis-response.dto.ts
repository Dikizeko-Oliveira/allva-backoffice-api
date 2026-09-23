import { ApiProperty } from '@nestjs/swagger';

/**
 * `POST /ads/{id}/analyze` — a análise do par `(Creative, Ad)` (§11).
 *
 * **A unidade é o par, não o criativo.** O mesmo criativo em cinco anúncios tem
 * cinco desempenhos, e é por isso que `POST /creatives/{id}/optimize` foi
 * removida em vez de renomeada: um endpoint indexado por criativo não tem como
 * devolver os cinco.
 */

export class AnalysisScoreDto {
  @ApiProperty({ example: 41 })
  aiScore!: number;

  @ApiProperty({ example: 0.72 })
  aiConfidence!: number;

  @ApiProperty({ example: 0.85 })
  coverageRatio!: number;
}

export class AnalysisCrossAdDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'A dispersão do desempenho do mesmo criativo entre anúncios.',
  })
  dispersion!: Record<string, unknown> | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      '`null` abaixo de três anúncios comparáveis — sem conclusão, e dito. ' +
      '`meta.evidenceSufficiency` vem `INSUFFICIENT` nesse caso.',
  })
  verdict!: Record<string, unknown> | null;

  @ApiProperty({
    example: 4,
    description: 'Quantos anúncios entraram na comparação.',
  })
  compared!: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Quem ficou de fora e por quê — omitir faria a comparação parecer completa.',
  })
  excluded!: unknown[];
}

/**
 * §11.4 passo 5 — **o que mudar no texto, e por quê**.
 *
 * É a ponte que a geração de copy consome. A sugestão **não é a copy**: ela
 * representa a mudança que a análise recomenda, e a separação é o que mantém
 * diagnóstico e texto autoral desacoplados — com todos os provedores de IA fora
 * do ar, este bloco continua vindo inteiro.
 */
export class CreativeSuggestionDto {
  @ApiProperty({
    enum: [
      'WEAK_HOOK',
      'THIN_BODY',
      'MISSING_HEADLINE',
      'MESSAGE_ATTRACTS_WRONG_AUDIENCE',
      'NEGATIVE_FEEDBACK_RISK',
      'MESSAGE_EXHAUSTED',
      'MISSING_CTA',
      'WEAK_CTA',
    ],
  })
  type!: string;

  @ApiProperty({ enum: ['HOOK', 'BODY', 'CTA', 'FORMAT'] })
  target!: string;

  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH'] })
  priority!: string;

  @ApiProperty({
    description:
      'O que foi observado, **com o número** que sustenta (P7). Uma sugestão ' +
      'sem a medida que a originou é uma afirmação que o produto não pode ' +
      'defender quando perguntarem de onde ela saiu.',
  })
  reason!: string;

  @ApiProperty({
    description:
      'O que mudar — nunca o texto novo. Escrever o texto é a geração de copy, ' +
      'e ela é a única parte autoral do fluxo.',
  })
  recommendation!: string;

  @ApiProperty({ example: 0.78 })
  confidence!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'O componente do score que originou a regra. `null` nas regras factuais ' +
      '— campo vazio no criativo —, que não herdam incerteza de medição.',
  })
  sourceComponent!: string | null;
}

export class AnalysisSuggestionsDto {
  @ApiProperty({ type: [CreativeSuggestionDto] })
  hook!: CreativeSuggestionDto[];

  @ApiProperty({ type: [CreativeSuggestionDto] })
  body!: CreativeSuggestionDto[];

  @ApiProperty({ type: [CreativeSuggestionDto] })
  cta!: CreativeSuggestionDto[];

  @ApiProperty({ type: [CreativeSuggestionDto] })
  format!: CreativeSuggestionDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '**Por que as listas acima estão vazias**, quando a ausência é decisão e ' +
      'não silêncio. O caso vivo é `AUDIENCE_MISMATCH`: a peça rende bem nos ' +
      'outros anúncios do mesmo criativo, e reescrever a copy consertaria o ' +
      'que não está quebrado. Sem este campo a tela leria "não há nada a ' +
      'melhorar" — o oposto da conclusão da análise.',
  })
  withheld!: string | null;
}

export class AdAnalysisResultDto {
  @ApiProperty()
  analysisId!: string;

  @ApiProperty()
  adId!: string;

  @ApiProperty()
  creativeId!: string;

  @ApiProperty({ example: 'analysis-1.0.0' })
  version!: string;

  @ApiProperty({
    description:
      'P9 visível na resposta. Sem isto, quem chama duas vezes vê respostas ' +
      'idênticas e conclui que a segunda recalculou — e a economia que P9 ' +
      'produz fica indistinguível de um bug.',
  })
  reusedPreviousAnalysis!: boolean;

  @ApiProperty({ type: AnalysisScoreDto })
  score!: AnalysisScoreDto;

  @ApiProperty({ type: AnalysisCrossAdDto })
  crossAd!: AnalysisCrossAdDto;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description: 'Candidatos de substituição, quando há material comparável.',
  })
  replacement!: unknown[];

  @ApiProperty({
    type: AnalysisSuggestionsDto,
    description:
      'A ponte entre a análise e a geração de copy. Determinística: nasce das ' +
      'regras de §11.4 sobre os componentes do score e sobre o criativo, antes ' +
      'de qualquer chamada de LLM.',
  })
  suggestions!: AnalysisSuggestionsDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '**P4 visível na resposta.** `narrative: null` com `enrichedByAI: false` ' +
      'é o contrato quando o provider caiu, o orçamento estourou ou não houve ' +
      'veredito a explicar — e o diagnóstico acima continua o mesmo nos três ' +
      'casos. Omitir os campos faria "a IA não falou" parecer "a IA não existe".',
  })
  narrative!: string | null;

  @ApiProperty()
  enrichedByAI!: boolean;

  @ApiProperty({
    description:
      'A leitura com IA faz parte do plano **vigente** da organização. ' +
      'Com `enrichedByAI: false`, é o que separa "seu plano não inclui" — ' +
      'acionável, e a tela oferece o upgrade — de "a IA não falou desta vez", ' +
      'que não é. Sem este campo os dois casos chegavam à tela idênticos: ' +
      'a narrativa simplesmente não aparecia.\n\n' +
      'Resolvido na leitura, e não gravado junto da análise, de propósito: ' +
      'é um fato sobre o plano de **agora**. Um `SKIPPED_PLAN` carimbado na ' +
      'linha continuaria dizendo "não incluído" depois do upgrade — logo ' +
      'depois de a pessoa pagar, que é o pior momento para errar isso.',
  })
  aiReadingIncludedInPlan!: boolean;
}
