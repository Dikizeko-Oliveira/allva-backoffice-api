import {
  SUPPORT_ATTENTION_SIGNALS,
  type SupportAttentionKey,
} from 'src/modules/operations-hub/domain/attention-signals';

/**
 * Quando uma regra de alerta dispara (GAP-044) — funções puras, sem banco.
 *
 * ## Só os sinais que este serviço enxerga sozinho
 *
 * O job não tem operador logado, e o backoffice-api não tem credencial
 * própria no `allva-api` (`docs/backoffice-api.md` §6). Por isso avalia só os
 * sinais de atendimento que moram no banco **deste** serviço. Os do produto
 * (`billing.*`, `operations.*`…) ficam `NOT_EVALUATED` até existir a conta de
 * serviço; `support.assigned_to_me_waiting` também, porque depende de quem
 * pergunta.
 */
export const LOCALLY_EVALUATED_SIGNALS = SUPPORT_ATTENTION_SIGNALS.filter(
  (signal) => signal.key !== 'support.assigned_to_me_waiting',
);

export type LocallyEvaluatedSource =
  (typeof LOCALLY_EVALUATED_SIGNALS)[number]['key'];

export function isLocallyEvaluatedSource(
  source: string,
): source is LocallyEvaluatedSource {
  return LOCALLY_EVALUATED_SIGNALS.some((signal) => signal.key === source);
}

export type ThresholdPredicate = (count: number) => boolean;

const THRESHOLD = /^\s*(?:count\s*)?(>=|>|==|=)\s*(\d+)\s*$/i;

/**
 * `>= 3`, `> 0`, `== 1` — com ou sem o `count` na frente, que é como
 * `docs/backoffice-api.md` §4.5 escreve. Qualquer outra forma é `null`: a regra
 * fica sem avaliar, e nunca dispara por uma leitura criativa do texto.
 */
export function parseAlertThreshold(
  threshold: string,
): ThresholdPredicate | null {
  const match = THRESHOLD.exec(threshold);
  if (!match) return null;

  const limit = Number(match[2]);

  switch (match[1]) {
    case '>=':
      return (count) => count >= limit;
    case '>':
      return (count) => count > limit;
    default:
      return (count) => count === limit;
  }
}

export type AlertRuleDecision =
  | { kind: 'FIRE'; severity: string; count: number }
  | { kind: 'HOLD_OPEN_EVENT' }
  | { kind: 'BELOW_THRESHOLD' }
  | {
      kind: 'NOT_EVALUATED';
      reason:
        | 'SOURCE_NOT_LOCAL'
        | 'THRESHOLD_UNPARSEABLE'
        | 'SIGNAL_UNAVAILABLE';
    };

/**
 * Dispara quando o sinal passa do limiar e a regra não tem evento aberto.
 * Deduplicar pelo evento aberto é o §4.5: o mesmo alerta não dispara de novo
 * até alguém reconhecê-lo.
 */
export function decideAlertRule(input: {
  source: string;
  threshold: string;
  count: number | undefined;
  hasOpenEvent: boolean;
}): AlertRuleDecision {
  if (!isLocallyEvaluatedSource(input.source)) {
    return { kind: 'NOT_EVALUATED', reason: 'SOURCE_NOT_LOCAL' };
  }

  const predicate = parseAlertThreshold(input.threshold);
  if (!predicate) {
    return { kind: 'NOT_EVALUATED', reason: 'THRESHOLD_UNPARSEABLE' };
  }

  // A contagem falhou: o hub já some com o sinal nesse caso, e o alerta não
  // pode dispará-lo nem dá-lo como zerado.
  if (input.count === undefined) {
    return { kind: 'NOT_EVALUATED', reason: 'SIGNAL_UNAVAILABLE' };
  }

  if (!predicate(input.count)) return { kind: 'BELOW_THRESHOLD' };
  if (input.hasOpenEvent) return { kind: 'HOLD_OPEN_EVENT' };

  return {
    kind: 'FIRE',
    severity: severityOf(input.source),
    count: input.count,
  };
}

function severityOf(source: SupportAttentionKey): string {
  return (
    SUPPORT_ATTENTION_SIGNALS.find((signal) => signal.key === source)
      ?.severity ?? 'WARNING'
  );
}
