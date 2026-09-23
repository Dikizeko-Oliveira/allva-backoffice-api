import type { AttentionSignalKey } from '../attention-signals';

/**
 * Conta os sinais pedidos, **e só eles**.
 *
 * Recebe as chaves já filtradas pela permissão do operador: a implementação
 * não roda consulta de sinal que ninguém vai ver. Isso não é só economia — é o
 * que garante que uma falha na tabela de faturas não derrube o hub do suporte.
 */
export abstract class AttentionCountsReaderInterface {
  abstract count(
    keys: readonly AttentionSignalKey[],
    now: Date,
  ): Promise<Partial<Record<AttentionSignalKey, number>>>;
}
