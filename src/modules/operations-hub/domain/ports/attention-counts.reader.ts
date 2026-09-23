import type {
  AttentionSeverity,
  SupportAttentionKey,
} from '../attention-signals';

export type UnacknowledgedAlertCount = {
  permission: string;
  severity: AttentionSeverity;
  count: number;
};

/**
 * Conta os sinais pedidos, **e só eles** — as chaves chegam já filtradas pela
 * permissão do operador.
 *
 * Cada contagem é isolada: a que falhar some do resultado e o resto segue. O
 * use case devolve a que sumiu como `count: null`, "indisponível".
 */
export abstract class AttentionCountsReaderInterface {
  abstract countSupport(
    keys: readonly SupportAttentionKey[],
    operatorId: string,
    now: Date,
  ): Promise<Partial<Record<SupportAttentionKey, number>>>;

  /** Só dos alertas cuja regra exige uma das `permissions`. */
  abstract countUnacknowledgedAlerts(
    permissions: readonly string[],
  ): Promise<UnacknowledgedAlertCount[]>;
}
