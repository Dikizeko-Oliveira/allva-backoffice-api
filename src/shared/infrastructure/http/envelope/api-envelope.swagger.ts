import { Type, applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * O envelope de §7.0 **descrito em OpenAPI**.
 *
 * O interceptor já produzia `{ data, meta }` desde A2-S0, e o Swagger não sabia
 * disso: as rotas ads-first declaravam `@ApiOperation` e nada sobre a resposta,
 * então `/docs-json` descrevia 47 operações sem shape. Quem integra tinha duas
 * saídas — ler os presenters no código-fonte ou chamar e observar —, e as duas
 * produzem um cliente acoplado ao que a rota devolveu no dia em que alguém
 * olhou, não ao contrato.
 *
 * **Os DTOs aqui são de documentação, não de runtime.** Nenhum handler os
 * instancia; eles existem para que o gerador de tipos do cliente tenha o que
 * gerar. É por isso que espelham os `type` do domínio em vez de substituí-los —
 * o tipo continua sendo a fonte de verdade, e a divergência entre os dois é
 * cobrada por `swagger-response-coverage.spec.ts`.
 */

/**
 * §7.0.2 — o **único** shape monetário de saída.
 *
 * Nunca `number`: um valor sem moeda obriga a tela a assumir a da organização, e
 * a conta em USD dentro de uma organização em BRL é exatamente o caso em que
 * assumir erra. `valueBase` é o mesmo dinheiro na moeda-base, e `fxRate`
 * ausente distingue os dois casos legítimos (conta já na base, ou linha com
 * normalização pendente).
 */
export class MoneyViewDto {
  @ApiProperty({ example: 1520.75, description: 'Valor na moeda da conta.' })
  value!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({
    example: 8210.05,
    description: 'O mesmo valor na moeda-base.',
  })
  valueBase!: number;

  @ApiProperty({ example: 'BRL' })
  baseCurrency!: string;

  @ApiPropertyOptional({
    example: 5.4,
    description:
      'Ausente quando a conta já está na moeda-base, ou quando a linha tem ' +
      'normalização pendente — nesse caso `valueBase` é estimativa declarada.',
  })
  fxRate?: number;

  @ApiPropertyOptional({
    example: '2026-08-03',
    description: 'A data da linha, nunca a de hoje (M2).',
  })
  fxAsOf?: string;
}

/** §7.0.1 — as versões que produziram o número. */
export class ProvenanceDto {
  @ApiPropertyOptional({
    example: 7,
    description:
      'A janela ativa da organização (DEC-11: declarada, não filtrada).',
  })
  windowDays?: number;

  @ApiPropertyOptional({ example: 'score-1.2.0' })
  algoVersion?: string;

  @ApiPropertyOptional({ example: 'detector-2.0.1' })
  detectorVersion?: string;

  @ApiPropertyOptional({ example: 'profile-3' })
  detectorProfileVersion?: string;

  @ApiPropertyOptional({ example: 'engine-1.0.0' })
  engineVersion?: string;

  @ApiPropertyOptional({
    example: 'measure-1.0.0',
    description:
      'A terceira coisa versionada do sistema. Dois números do mesmo painel ' +
      'com versões diferentes vieram de réguas diferentes.',
  })
  measurementVersion?: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'Itens fora do recorte por não casarem a janela declarada.',
  })
  excludedByWindowMismatch?: number;

  @ApiPropertyOptional({
    example: 12,
    description:
      'Quantos ficaram fora da ordenação pelos pisos de §12.4 — o número, e ' +
      'não só o rótulo: "alguns foram omitidos" não é acionável.',
  })
  excludedByScoreFloor?: number;

  @ApiProperty({
    required: false,
    example: '2026-02-22',
    description:
      'Presente quando a leitura foi cortada no piso de histórico do plano. ' +
      'A ausência significa que a janela pedida coube inteira.',
  })
  historyTruncatedAt?: string;
}

export class OrganizationMetaDto {
  @ApiProperty({ example: 'BRL' })
  baseCurrency!: string;

  @ApiProperty({
    example: false,
    description:
      '§8.7 — em recomputo de moeda os agregados estão sendo reescritos, e a ' +
      'tela precisa saber para não apresentar um valor a meio caminho.',
  })
  recomputingCurrency!: boolean;
}

/**
 * §7.0.5 — **duas formas, e `hasMore` é a única comum às duas.**
 *
 * Lista volátil (inteligência) devolve `nextCursor`; lista de contexto, cuja
 * ordenação é estável e por isso pagina por `page`/`limit`, devolve `total`.
 * Cada rota preenche uma das duas — ler o campo da outra é sinal de que o
 * cliente supôs a paginação errada.
 */
export class PageMetaDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'eyJrIjpbMTIuNV0sImkiOiJhZC0xIn0',
    description:
      'Listas por cursor. Opaco: repasse como `cursor=`, não parseie.',
  })
  nextCursor?: string | null;

  @ApiPropertyOptional({
    type: Number,
    example: 137,
    description:
      'Listas de contexto (`page`/`limit`). Quantos existem no total — ' +
      'página e limite o cliente já sabe, porque foi ele quem os pediu.',
  })
  total?: number;

  @ApiProperty({ example: true })
  hasMore!: boolean;
}

export class ResponseMetaDto {
  @ApiPropertyOptional({
    example: '2026-08-03T06:00:00.000Z',
    description: 'O instante a que o dado se refere — não o da resposta.',
  })
  asOf?: string;

  @ApiPropertyOptional({ enum: ['IMMATURE', 'SETTLING', 'MATURE'] })
  dataMaturity?: string;

  @ApiPropertyOptional({ enum: ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'] })
  evidenceSufficiency?: string;

  @ApiPropertyOptional({ type: ProvenanceDto })
  provenance?: ProvenanceDto;

  @ApiPropertyOptional({ type: OrganizationMetaDto })
  organization?: OrganizationMetaDto;

  @ApiPropertyOptional({ type: PageMetaDto })
  page?: PageMetaDto;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { META: 1, GOOGLE: 0.45 },
    description:
      '§12.2 — quanto do modelo de score cada plataforma permite cobrir. Sem ' +
      'isto, cobertura 0,45 no Search e 0,45 na Meta pareceriam iguais, e a ' +
      'primeira está no teto do que é possível medir.',
  })
  coverageByPlatform?: Record<string, number>;
}

type EnvelopeOptions = {
  status?: number;
  description?: string;
  isArray?: boolean;
};

/**
 * Declara a resposta de uma rota envelopada: `{ data: <model>, meta }`.
 *
 * O `meta` entra por `$ref` e não inline para que o gerador do cliente produza
 * **um** tipo `ResponseMeta` compartilhado. Inline, cada rota geraria um tipo
 * anônimo próprio e a procedência deixaria de ser comparável entre telas no
 * cliente — que é a razão de o `meta` existir.
 */
export function ApiEnvelopeResponse(
  model: Type<unknown>,
  options: EnvelopeOptions = {},
) {
  const dataSchema = options.isArray
    ? { type: 'array' as const, items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };

  return applyDecorators(
    ApiExtraModels(ResponseMetaDto, model),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: dataSchema,
          meta: { $ref: getSchemaPath(ResponseMetaDto) },
        },
      },
    }),
  );
}

/**
 * Rotas envelopadas cujo `data` é livre por construção — o relatório de um
 * dry-run, por exemplo, cujo conteúdo depende da guarda que reprovou.
 *
 * Existe para que a rota **declare** que devolve o envelope mesmo quando o
 * miolo não é fixo. A alternativa seria não declarar nada, e aí o cliente não
 * sabe nem que há um `meta`.
 */
export function ApiEnvelopeRawResponse(options: EnvelopeOptions = {}) {
  return applyDecorators(
    ApiExtraModels(ResponseMetaDto),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'object', additionalProperties: true },
          meta: { $ref: getSchemaPath(ResponseMetaDto) },
        },
      },
    }),
  );
}
