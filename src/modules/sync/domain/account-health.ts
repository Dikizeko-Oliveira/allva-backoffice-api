/**
 * Saúde de sincronização da `AdAccount` (§4.1 R-H, DEC-8/D17).
 *
 * `Ad.syncState` descreve **um anúncio**. Mas a guarda de arquivamento (§8.2), a
 * reconciliação de frescor (§8.5c), o rebind (§8.6) e a tabela de degradação
 * (§8.7) decidem sobre a **conta inteira** — "não conseguimos ver tudo" não é
 * propriedade de um anúncio. Sem estado de conta, a correção central do sync não
 * teria onde registrar seu veredito, e "levar a conta a `UNREACHABLE`" seria uma
 * frase impossível de escrever.
 */

export type AdAccountSyncHealth = 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';

/**
 * Vocabulário fechado do motivo. Uma string livre aqui vira dezoito grafias da
 * mesma condição no primeiro trimestre, e o painel de operação deixa de agrupar.
 */
export type SyncHealthReason =
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_MISSING'
  | 'SCOPE_LOST'
  | 'ACCOUNT_NOT_ACCESSIBLE'
  | 'INCOMPLETE_RESPONSE'
  | 'PLATFORM_ERROR'
  | 'PARTIAL_INGEST'
  | 'METRICS_STALE'
  | 'RECOVERED';

export type SyncHealthVerdict = {
  health: AdAccountSyncHealth;
  reason: SyncHealthReason | null;
};

/**
 * As causas que significam "perdemos acesso", não "a leitura saiu incompleta".
 *
 * A distinção decide se as **ações** ficam bloqueadas: numa conta `DEGRADED` a
 * mídia continua alcançável e pausar um anúncio caro ainda funciona; numa
 * `UNREACHABLE`, não temos como saber se a escrita chegou.
 */
const UNREACHABLE_REASONS: ReadonlySet<SyncHealthReason> = new Set([
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_MISSING',
  'SCOPE_LOST',
  'ACCOUNT_NOT_ACCESSIBLE',
  'INCOMPLETE_RESPONSE',
  'PLATFORM_ERROR',
]);

/**
 * O veredito de saúde a partir do que o ingest conseguiu ver.
 *
 * `wasComplete = false` é `UNREACHABLE` de propósito, e é a metade da correção
 * central de §8.2: uma resposta truncada não autoriza concluir nada sobre o que
 * não veio. A outra metade é a guarda de arquivamento, que lê este veredito.
 */
export function healthFromIngest(input: {
  /** A resposta cobriu o escopo pedido inteiro. */
  wasComplete: boolean;
  /** Etapas que falharam, na ordem em que rodaram. */
  failedSteps: string[];
  /** Falha de credencial/escopo, que não é a mesma coisa que falha de leitura. */
  accessFailure?: SyncHealthReason | null;
}): SyncHealthVerdict {
  if (input.accessFailure) {
    return {
      health: UNREACHABLE_REASONS.has(input.accessFailure)
        ? 'UNREACHABLE'
        : 'DEGRADED',
      reason: input.accessFailure,
    };
  }

  if (!input.wasComplete) {
    return { health: 'UNREACHABLE', reason: 'INCOMPLETE_RESPONSE' };
  }

  if (input.failedSteps.length > 0) {
    return { health: 'DEGRADED', reason: 'PARTIAL_INGEST' };
  }

  return { health: 'HEALTHY', reason: 'RECOVERED' };
}

/**
 * A tabela de degradação de §8.7, como dado.
 *
 * `archiving` é a coluna que a guarda de §8.2 consulta; `detection` é normativa:
 * o auto-resolve só pode concluir que "a condição cessou" a partir de
 * **observação válida**. Sem sync bem-sucedido os itens abertos permanecem
 * abertos — **ausência de dado nunca é evidência de resolução**.
 */
export type DegradationPolicy = {
  ingest: 'RUNS' | 'FAILS_AND_REPORTS';
  scoring: boolean;
  detection: boolean;
  recommendations: boolean;
  actions: boolean;
  archiving: boolean;
};

export const DEGRADATION_BY_HEALTH: Readonly<
  Record<AdAccountSyncHealth, DegradationPolicy>
> = {
  HEALTHY: {
    ingest: 'RUNS',
    scoring: true,
    detection: true,
    recommendations: true,
    actions: true,
    archiving: true,
  },
  DEGRADED: {
    ingest: 'RUNS',
    scoring: false,
    detection: false,
    recommendations: false,
    // A mídia continua alcançável: pausar um anúncio caro ainda é possível e
    // ainda é a coisa certa a fazer. É a leitura que está degradada.
    actions: true,
    archiving: false,
  },
  UNREACHABLE: {
    ingest: 'FAILS_AND_REPORTS',
    scoring: false,
    detection: false,
    recommendations: false,
    actions: false,
    archiving: false,
  },
};

export function degradationFor(health: AdAccountSyncHealth): DegradationPolicy {
  return DEGRADATION_BY_HEALTH[health];
}

/**
 * `unreachableSince` é carimbado **na entrada** no estado e preservado enquanto
 * ele durar: reescrevê-lo a cada tentativa faria "há quanto tempo esta conta
 * está cega" ser sempre "alguns minutos", que é a única informação que a coluna
 * existe para dar.
 */
export function nextUnreachableSince(input: {
  current: Date | null;
  previousHealth: AdAccountSyncHealth;
  nextHealth: AdAccountSyncHealth;
  now: Date;
}): Date | null {
  if (input.nextHealth !== 'UNREACHABLE') return null;
  if (input.previousHealth === 'UNREACHABLE' && input.current) {
    return input.current;
  }
  return input.now;
}
