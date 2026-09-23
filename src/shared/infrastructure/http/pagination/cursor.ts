import { PageMeta } from '../envelope/response-meta';
import { DomainError } from '../errors/domain-error';

/**
 * Paginação por cursor (§7.0.5).
 *
 * Listas voláteis — `/ads`, `/waste/items`, `/recommendations`, séries — não
 * podem paginar por offset: a ordenação padrão muda a cada ciclo de scoring, e
 * uma linha que sobe de posição entre a página 1 e a 2 aparece duas vezes
 * enquanto outra some. Offset também não cabe no p95 de 400 ms com 100k linhas,
 * porque o banco varre tudo que pulou.
 *
 * O cursor é **keyset**: guarda os valores de ordenação da última linha
 * entregue e o `id` como desempate. A consulta seguinte é
 * `WHERE (sortKey, id) < (:key, :id)`, que usa índice e não relê nada.
 */

/** Valores admitidos como chave de ordenação — o que sobrevive a JSON. */
export type CursorKey = string | number | boolean | null;

export type CursorPayload = {
  /** Versão do formato: um cursor antigo tem que ser recusável, não reinterpretado. */
  v: 1;
  /** A ordenação sob a qual este cursor foi emitido, ex. `avoidableDaily:desc`. */
  sort: string;
  /** Valores das chaves de ordenação da última linha da página anterior. */
  keys: CursorKey[];
  /** Desempate estável. Sem ele, empates fazem linhas sumirem entre páginas. */
  id: string;
};

const CURSOR_VERSION = 1 as const;

/** Opaco de propósito: base64url de JSON. Não é segredo — é "não mexa nisto". */
export function encodeCursor(payload: Omit<CursorPayload, 'v'>): string {
  const body = JSON.stringify({ v: CURSOR_VERSION, ...payload });
  return Buffer.from(body, 'utf8').toString('base64url');
}

/**
 * Decodifica o cursor e **exige** que ele tenha sido emitido sob a mesma
 * ordenação que está sendo pedida agora.
 *
 * É isso que "estável sob reordenação" significa na prática: trocar de
 * ordenação no meio da paginação não pode continuar de onde parou, porque o
 * "onde parou" era uma posição em outra lista. Recusar é a única resposta
 * correta — continuar produz uma página que omite linhas sem avisar ninguém.
 */
export function decodeCursor(
  cursor: string,
  expectedSort: string,
): CursorPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('O cursor informado não pôde ser lido.');
  }

  if (!isCursorPayload(parsed)) {
    throw invalidCursor('O cursor informado não pôde ser lido.');
  }

  if (parsed.v !== CURSOR_VERSION) {
    throw invalidCursor(
      'O cursor informado é de um formato anterior e não pode ser usado.',
    );
  }

  if (parsed.sort !== expectedSort) {
    throw new DomainError({
      code: 'CURSOR_SORT_MISMATCH',
      category: 'VALIDATION',
      message: 'O cursor foi emitido sob outra ordenação.',
      details: { cursorSort: parsed.sort, requestedSort: expectedSort },
      remediation: 'Refaça a busca sem cursor para começar a nova ordenação.',
    });
  }

  return parsed;
}

/**
 * Fecha a página a partir de `limit + 1` linhas lidas.
 *
 * Ler uma linha a mais é como se sabe que existe próxima página sem um
 * `COUNT(*)` — que, na tabela particionada de métricas, custa mais que a
 * consulta inteira.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  sort: string,
  keysOf: (row: T) => { keys: CursorKey[]; id: string },
): { items: T[]; page: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    page: {
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor({ sort, ...keysOf(last) }) : null,
    },
  };
}

function invalidCursor(message: string): DomainError {
  return new DomainError({
    code: 'INVALID_CURSOR',
    category: 'VALIDATION',
    message,
    remediation: 'Refaça a busca sem cursor.',
  });
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.v === 'number' &&
    typeof candidate.sort === 'string' &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.keys)
  );
}
