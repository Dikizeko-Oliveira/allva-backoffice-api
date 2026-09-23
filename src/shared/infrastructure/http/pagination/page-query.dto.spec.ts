import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CURSOR_PAGE_DEFAULT_LIMIT,
  CURSOR_PAGE_MAX_LIMIT,
  PageQueryDto,
  resolveLimit,
} from './page-query.dto';

function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(PageQueryDto, query);
  return { dto, errors: validateSync(dto) };
}

describe('PageQueryDto', () => {
  it('aceita cursor e limite dentro do teto', () => {
    const { dto, errors } = parse({ cursor: 'abc', limit: '50' });

    expect(errors).toEqual([]);
    expect(dto.limit).toBe(50);
  });

  it('recusa limite acima do teto da superfície', () => {
    const { errors } = parse({ limit: String(CURSOR_PAGE_MAX_LIMIT + 1) });

    // O teto é da superfície inteira: um endpoint não pode afrouxá-lo por
    // conta própria e transformar uma lista volátil em varredura.
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('limit');
  });

  it('recusa limite zero ou negativo', () => {
    expect(parse({ limit: '0' }).errors).toHaveLength(1);
    expect(parse({ limit: '-5' }).errors).toHaveLength(1);
  });

  it('não exige nada — lista sem parâmetro é a primeira página', () => {
    const { dto, errors } = parse({});

    expect(errors).toEqual([]);
    expect(dto.limit).toBeUndefined();
  });
});

describe('resolveLimit', () => {
  it('aplica o default quando não veio limite', () => {
    expect(resolveLimit()).toBe(CURSOR_PAGE_DEFAULT_LIMIT);
    expect(resolveLimit(0)).toBe(CURSOR_PAGE_DEFAULT_LIMIT);
  });

  it('trunca no teto e no piso', () => {
    expect(resolveLimit(1_000)).toBe(CURSOR_PAGE_MAX_LIMIT);
    expect(resolveLimit(-3)).toBe(1);
    expect(resolveLimit(10)).toBe(10);
  });
});
