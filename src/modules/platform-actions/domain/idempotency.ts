import { createHash } from 'node:crypto';

/**
 * A8 / ⊕2 — **a chave é do cliente, o dígito é nosso.**
 *
 * `Idempotency-Key` responde *"é o mesmo pedido?"*. Sozinha ela não basta: um
 * cliente que reaproveita a chave com outro corpo — retry de um formulário que
 * o usuário editou entre as tentativas — receberia o resultado da ação
 * **anterior** como se fosse o da nova. O dígito do pedido é o que transforma
 * esse caso num erro em vez de numa confusão silenciosa.
 *
 * Por isso o par: chave igual **e** dígito igual ⇒ replay legítimo, devolve o
 * original; chave igual e dígito diferente ⇒ 409 `IDEMPOTENCY_KEY_REUSED`.
 */

export type DigestInput = {
  adId: string;
  actionType: string;
  targetEntityType: string;
  targetEntityId: string;
  parameters: unknown;
  dryRun: boolean;
};

/**
 * SHA-256 sobre a forma canônica do pedido.
 *
 * `JSON.stringify` cru não serve: `{a:1,b:2}` e `{b:2,a:1}` são o mesmo pedido e
 * produziriam dígitos diferentes, transformando todo replay de um cliente que
 * serializa em ordem instável num falso `IDEMPOTENCY_KEY_REUSED`.
 */
export function requestDigest(input: DigestInput): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

/** JSON com chaves ordenadas em toda profundidade. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    // Ordem de array é significativa — dois criativos em ordem trocada são
    // pedidos diferentes, e normalizá-la esconderia a diferença.
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalize(entryValue)}`,
    );

  return `{${entries.join(',')}}`;
}

/**
 * O que fazer diante de uma chave já vista.
 *
 * `dryRun` entra no dígito de propósito: validar e executar são pedidos
 * diferentes, e reaproveitar a chave do dry-run para a escrita real devolveria
 * o resultado da validação — um `202` que nunca escreveu nada.
 */
export type IdempotencyOutcome =
  | { kind: 'FRESH' }
  | { kind: 'REPLAY'; executionId: string }
  | { kind: 'REUSED_WITH_DIFFERENT_PAYLOAD' };

export function resolveIdempotency(input: {
  existing: { executionId: string; requestDigest: string } | null;
  digest: string;
}): IdempotencyOutcome {
  if (!input.existing) return { kind: 'FRESH' };

  if (input.existing.requestDigest === input.digest) {
    return { kind: 'REPLAY', executionId: input.existing.executionId };
  }

  return { kind: 'REUSED_WITH_DIFFERENT_PAYLOAD' };
}

/**
 * O dígito de um texto — a régua com que R14 compara o que foi confirmado com o
 * que vai ao ar.
 *
 * Normaliza espaço em branco de borda e nada mais: um texto que difere por um
 * parágrafo a mais **é** outro texto, e tratá-lo como igual é o caso que a
 * confirmação existe para impedir.
 */
export function contentDigest(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}
