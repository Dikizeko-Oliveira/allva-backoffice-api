import { DomainError } from '../errors/domain-error';
import { buildPage, decodeCursor, encodeCursor } from './cursor';

const SORT = 'avoidableDaily:desc';

describe('cursor', () => {
  it('faz round-trip preservando ordenação, chaves e desempate', () => {
    const cursor = encodeCursor({
      sort: SORT,
      keys: [88.5, '2026-07-30'],
      id: 'ad-9',
    });

    expect(decodeCursor(cursor, SORT)).toEqual({
      v: 1,
      sort: SORT,
      keys: [88.5, '2026-07-30'],
      id: 'ad-9',
    });
  });

  it('é opaco — nada do formato interno vaza para o cliente', () => {
    const cursor = encodeCursor({ sort: SORT, keys: [1], id: 'ad-1' });

    expect(cursor).not.toContain('avoidableDaily');
    expect(cursor).not.toContain('ad-1');
  });

  it('recusa cursor emitido sob outra ordenação', () => {
    const cursor = encodeCursor({ sort: SORT, keys: [1], id: 'ad-1' });

    expect(() => decodeCursor(cursor, 'aiScore:asc')).toThrow(DomainError);

    try {
      decodeCursor(cursor, 'aiScore:asc');
    } catch (error) {
      const domainError = error as DomainError;
      expect(domainError.code).toBe('CURSOR_SORT_MISMATCH');
      expect(domainError.category).toBe('VALIDATION');
      expect(domainError.httpStatus).toBe(400);
      expect(domainError.details).toEqual({
        cursorSort: SORT,
        requestedSort: 'aiScore:asc',
      });
    }
  });

  it('recusa cursor corrompido com erro tipado, nunca com 500', () => {
    expect(() => decodeCursor('não-é-base64-de-json', SORT)).toThrow(
      DomainError,
    );

    try {
      decodeCursor('não-é-base64-de-json', SORT);
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_CURSOR');
    }
  });

  it('recusa cursor de versão anterior em vez de reinterpretá-lo', () => {
    const legacy = Buffer.from(
      JSON.stringify({ v: 0, sort: SORT, keys: [1], id: 'ad-1' }),
      'utf8',
    ).toString('base64url');

    try {
      decodeCursor(legacy, SORT);
      fail('deveria ter recusado');
    } catch (error) {
      expect((error as DomainError).code).toBe('INVALID_CURSOR');
    }
  });
});

describe('buildPage', () => {
  const rows = [
    { id: 'a', score: 90 },
    { id: 'b', score: 80 },
    { id: 'c', score: 70 },
  ];
  const keysOf = (row: { id: string; score: number }) => ({
    keys: [row.score],
    id: row.id,
  });

  it('corta a linha extra e devolve cursor apontando para a última entregue', () => {
    const { items, page } = buildPage(rows, 2, SORT, keysOf);

    expect(items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor!, SORT)).toMatchObject({
      keys: [80],
      id: 'b',
    });
  });

  it('fecha a paginação quando não veio linha extra', () => {
    const { items, page } = buildPage(rows, 3, SORT, keysOf);

    expect(items).toHaveLength(3);
    expect(page).toEqual({ hasMore: false, nextCursor: null });
  });

  it('não emite cursor para página vazia', () => {
    expect(buildPage([], 10, SORT, keysOf).page).toEqual({
      hasMore: false,
      nextCursor: null,
    });
  });
});
