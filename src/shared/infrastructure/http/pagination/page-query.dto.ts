import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { PageParams } from 'src/shared/domain/repositories/pagination';

export const PAGE_DEFAULT_SIZE = 20;
export const PAGE_MAX_SIZE = 100;

/**
 * Query base das listagens paginadas. Toda listagem estende esta classe em vez
 * de redeclarar `page`/`pageSize` — o teto é o mesmo em toda a superfície, e um
 * endpoint não pode afrouxá-lo por descuido.
 */
export class PageQueryDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page must be an integer' })
  @Min(1, { message: 'page must be at least 1' })
  page?: number = 1;

  @ApiProperty({ required: false, default: PAGE_DEFAULT_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize must be an integer' })
  @Min(1, { message: 'pageSize must be at least 1' })
  @Max(PAGE_MAX_SIZE, {
    message: `pageSize must be at most ${PAGE_MAX_SIZE}`,
  })
  pageSize?: number = PAGE_DEFAULT_SIZE;
}

/** A página efetiva, com default aplicado. */
export function resolvePage(query: PageQueryDto): PageParams {
  return {
    page: query.page ?? 1,
    pageSize: query.pageSize ?? PAGE_DEFAULT_SIZE,
  };
}
