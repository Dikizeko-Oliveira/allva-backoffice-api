import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';

/**
 * ④ Reconciliação (§8.5) — duas perguntas diferentes sobre o mesmo anúncio.
 *
 * **(a) Drift** é divergência da *nossa intenção*: pedimos pausar e a plataforma
 * continua veiculando. Só existe para ads com `desiredStatus != null`.
 *
 * **(b) Mudança externa** é alteração que *não pedimos*, e vale para **todos** os
 * ads — inclusive os que a Allva nunca tocou. É informação de produto: alguém
 * pausou, a plataforma reprovou, uma regra de orçamento agiu.
 *
 * Fundir as duas produziria o pior dos dois mundos: alertaria drift sobre
 * anúncio que nunca recebeu ação, e trataria uma reprovação da plataforma como
 * falha da nossa escrita.
 */

/** A escada de verificação de §8.5, em ms desde a escrita. */
export const VERIFICATION_LADDER_MS: readonly number[] = [
  90_000, // T+90s
  300_000, // T+5min
  1_800_000, // T+30min
  7_200_000, // T+2h
];

/**
 * Graça de 5 minutos antes de considerar divergência.
 *
 * Meta processa de forma assíncrona e Google pode aplicar parcialmente: os
 * primeiros minutos depois de uma escrita são o **caso normal** de divergência,
 * não o sintoma. Sem a graça, toda ação bem-sucedida geraria um alerta de drift
 * antes de a plataforma terminar de aplicá-la.
 */
export const DRIFT_GRACE_MS = 300_000;

export type DriftCause = 'UNVERIFIED_WRITE' | 'EXTERNAL_CHANGE';

export type DriftVerdict =
  /** Observado casa com o desejado: confirma, limpa a intenção, libera I2. */
  | { kind: 'IN_SYNC' }
  /** Dentro da graça: segue `PENDING_WRITE`, sem alarme. */
  | { kind: 'WITHIN_GRACE'; nextAttemptAt: Date }
  /** Fora da graça, escada não esgotada: agenda o próximo degrau. */
  | { kind: 'PENDING'; attempt: number; nextAttemptAt: Date }
  /**
   * Escada esgotada. É este ramo que impede o travamento permanente: sem estado
   * terminal, I2 manteria o anúncio indefinidamente sem aceitar novas ações, em
   * silêncio — exatamente o que §8.5 promete impedir.
   */
  | { kind: 'DRIFTED'; cause: 'UNVERIFIED_WRITE'; attemptsExhausted: number };

/**
 * (a) Drift contra a nossa intenção.
 *
 * `attempt` é quantos degraus da escada já foram tentados — 0 na primeira
 * passagem. A escada é contada a partir de `desiredStatusSetAt`, não do relógio
 * do worker: um reconcile atrasado não pode consumir três degraus de uma vez.
 */
export function evaluateDrift(input: {
  observedStatus: AdStatus;
  desiredStatus: AdStatus;
  desiredStatusSetAt: Date;
  attempt: number;
  now: Date;
}): DriftVerdict {
  if (input.observedStatus === input.desiredStatus) {
    return { kind: 'IN_SYNC' };
  }

  const elapsed = input.now.getTime() - input.desiredStatusSetAt.getTime();

  if (elapsed < DRIFT_GRACE_MS) {
    return {
      kind: 'WITHIN_GRACE',
      nextAttemptAt: new Date(
        input.desiredStatusSetAt.getTime() + DRIFT_GRACE_MS,
      ),
    };
  }

  const attempt = Math.max(0, input.attempt);

  if (attempt >= VERIFICATION_LADDER_MS.length) {
    return {
      kind: 'DRIFTED',
      cause: 'UNVERIFIED_WRITE',
      attemptsExhausted: attempt,
    };
  }

  return {
    kind: 'PENDING',
    attempt: attempt + 1,
    nextAttemptAt: new Date(
      input.desiredStatusSetAt.getTime() + VERIFICATION_LADDER_MS[attempt],
    ),
  };
}

/**
 * A causa provável de uma mudança externa, declarada.
 *
 * "Mudou" sem causa é um alerta que ninguém sabe o que fazer com. `DISAPPROVED`
 * e `PENDING_REVIEW` são a plataforma agindo; `PAUSED` sem ação nossa é quase
 * sempre um operador ou uma regra de orçamento — e as duas leituras pedem telas
 * diferentes.
 */
export type ExternalChangeCause =
  | 'PLATFORM_REVIEW'
  | 'PLATFORM_REJECTED'
  | 'OPERATOR_OR_RULE'
  | 'REMOVED_ON_PLATFORM'
  | 'UNKNOWN';

export function probableExternalCause(next: AdStatus): ExternalChangeCause {
  switch (next) {
    case 'PENDING_REVIEW':
      return 'PLATFORM_REVIEW';
    case 'DISAPPROVED':
      return 'PLATFORM_REJECTED';
    case 'PAUSED':
      return 'OPERATOR_OR_RULE';
    case 'ARCHIVED':
    case 'DELETED':
      return 'REMOVED_ON_PLATFORM';
    default:
      return 'UNKNOWN';
  }
}

export type ExternalChange = {
  from: AdStatus;
  to: AdStatus;
  cause: ExternalChangeCause;
};

/**
 * (b) Mudança que não pedimos.
 *
 * Devolve `null` quando não há mudança **ou** quando há intenção nossa em voo —
 * nesse caso a divergência é assunto de (a), e reportá-la como externa faria a
 * própria escrita da Allva aparecer como "alguém mexeu no seu anúncio".
 */
export function detectExternalChange(input: {
  previousObserved: AdStatus;
  observedStatus: AdStatus;
  desiredStatus: AdStatus | null;
}): ExternalChange | null {
  if (input.desiredStatus) return null;
  if (input.previousObserved === input.observedStatus) return null;
  if (input.previousObserved === 'UNKNOWN') return null;

  return {
    from: input.previousObserved,
    to: input.observedStatus,
    cause: probableExternalCause(input.observedStatus),
  };
}

/**
 * (c) Frescor. `STALE` é sobre a **métrica**; `UNREACHABLE`, sobre a
 * estrutura ou a integração.
 *
 * A diferença tem consequência de produto declarada em §8.5c: um anúncio
 * `STALE` por métrica **continua apto a receber ação** — sabemos o que ele é,
 * só não sabemos como foi ontem. Um `UNREACHABLE`, não.
 */
export const DEFAULT_METRICS_SLA_HOURS = 26;
export const DEFAULT_STRUCTURE_SLA_HOURS = 48;

export type FreshnessVerdict = 'FRESH' | 'STALE' | 'UNREACHABLE';

export function evaluateFreshness(input: {
  lastMetricsSyncAt: Date | null;
  lastStructureSyncAt: Date | null;
  integrationAvailable: boolean;
  now: Date;
  metricsSlaHours?: number;
  structureSlaHours?: number;
}): FreshnessVerdict {
  const metricsSla =
    (input.metricsSlaHours ?? DEFAULT_METRICS_SLA_HOURS) * 3_600_000;
  const structureSla =
    (input.structureSlaHours ?? DEFAULT_STRUCTURE_SLA_HOURS) * 3_600_000;

  if (!input.integrationAvailable) return 'UNREACHABLE';

  const structureAge = input.lastStructureSyncAt
    ? input.now.getTime() - input.lastStructureSyncAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (structureAge > structureSla) return 'UNREACHABLE';

  const metricsAge = input.lastMetricsSyncAt
    ? input.now.getTime() - input.lastMetricsSyncAt.getTime()
    : Number.POSITIVE_INFINITY;

  if (metricsAge > metricsSla) return 'STALE';

  return 'FRESH';
}
