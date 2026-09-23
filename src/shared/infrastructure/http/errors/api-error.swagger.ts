import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { DOMAIN_ERROR_HTTP_STATUS } from './domain-error';

/**
 * O erro tipado de §7.0.4 **descrito em OpenAPI**.
 *
 * A superfície ads-first responde erro num shape (`{ error: {…} }`) e a legada
 * noutro (`{ message, statusCode, path, timestamp }`). A divergência é real e
 * declarada — os ~25 módulos legados estão em produção e reescrevê-los num
 * commit de infraestrutura foi recusado em A2-S0 —, então o mínimo é que o
 * contrato diga **qual rota fala qual dialeto**, em vez de deixar o cliente
 * descobrir no primeiro 409.
 */
export class DomainErrorDetailDto {
  @ApiProperty({
    example: 'RECOMMENDATION_PREMISE_STALE',
    description:
      'Código específico e estável. É o que a UI usa para escolher a ' +
      'mensagem — nunca `ERR_409`.',
  })
  code!: string;

  @ApiProperty({
    enum: Object.keys(DOMAIN_ERROR_HTTP_STATUS),
    description:
      'A categoria decide o HTTP e o comportamento genérico do cliente; o ' +
      '`code` identifica o caso. Achatar os dois obrigaria o cliente a fazer ' +
      '`switch` em string para saber se pode tentar de novo.',
  })
  category!: string;

  @ApiProperty({ example: 'A premissa desta recomendação não vale mais.' })
  message!: string;

  @ApiProperty({
    example: false,
    description:
      'Só `RATE_LIMITED`, `INTEGRATION_UNREACHABLE`, `CURRENCY_RECOMPUTING` e ' +
      '`WRITE_IN_FLIGHT` nascem `true`. Repetir um 403 de RBAC gasta chamada.',
  })
  retryable!: boolean;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Estrutura livre por código — onde o erro da plataforma cai.',
  })
  details?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'Recarregue a recomendação para ver o plano atualizado.',
    description: 'O que o usuário faz agora. Texto de tela, não de log.',
  })
  remediation?: string;
}

export class DomainErrorDto {
  @ApiProperty({ type: DomainErrorDetailDto })
  error!: DomainErrorDetailDto;
}

/**
 * O formato de erro dos módulos **anteriores** à v2.0. Documentado porque
 * existe, não porque é desejável.
 */
export class LegacyErrorDto {
  @ApiProperty({ example: 'Anúncio não encontrado' })
  message!: string;

  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiPropertyOptional({ example: '/api/v1/ads/abc' })
  path?: string;

  @ApiPropertyOptional({ example: '2026-08-03T06:00:00.000Z' })
  timestamp?: string;
}

/**
 * Declara os erros tipados que uma rota pode devolver, um `status` por chamada.
 *
 * Recebe os códigos esperados porque é o `code`, e não o status, que decide a
 * mensagem na tela: dizer "esta rota devolve 409" não ajuda quem precisa
 * distinguir `WRITE_IN_FLIGHT` (espere) de `IDEMPOTENCY_KEY_REUSED` (você já
 * fez isto).
 */
export function ApiDomainError(
  status: number,
  description: string,
  codes: string[] = [],
) {
  const full = codes.length
    ? `${description} — \`code\`: ${codes.map((c) => `\`${c}\``).join(', ')}`
    : description;

  return applyDecorators(
    ApiResponse({ status, description: full, type: DomainErrorDto }),
  );
}
