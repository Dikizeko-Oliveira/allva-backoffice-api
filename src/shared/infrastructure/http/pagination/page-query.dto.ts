import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const CURSOR_PAGE_DEFAULT_LIMIT = 25;
export const CURSOR_PAGE_MAX_LIMIT = 100;

/**
 * Query base das listas voláteis de §7.0.5. Toda listagem ads-first estende
 * esta classe em vez de redeclarar `cursor`/`limit` — o teto máximo é o mesmo em
 * toda a superfície, e um endpoint não pode afrouxá-lo por descuido.
 *
 * Não há `page` aqui, e a ausência é o ponto: uma lista cuja ordenação muda a
 * cada ciclo não tem número de página que signifique alguma coisa.
 */
export class PageQueryDto {
  @ApiPropertyOptional({
    description:
      'Cursor opaco devolvido em `meta.page.nextCursor`. Só é válido sob a mesma ordenação.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: CURSOR_PAGE_MAX_LIMIT,
    default: CURSOR_PAGE_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CURSOR_PAGE_MAX_LIMIT)
  limit?: number;
}

/** O limite efetivo, já com default e teto aplicados. */
export function resolveLimit(limit?: number): number {
  if (!limit) return CURSOR_PAGE_DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), CURSOR_PAGE_MAX_LIMIT);
}
