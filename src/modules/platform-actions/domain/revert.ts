import type {
  AdActionParameters,
  ActionParameterType,
} from 'src/modules/ads/domain/actions/action-parameters.schema';
import { isBudgetAction } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import { fromMinorUnits } from 'src/shared/domain/money';

/**
 * §9.6 — **a reversão é uma ação nova, derivada de `previousState`.**
 *
 * Não é "desfazer": é uma escrita com origem `REVERT`, alvo próprio, execução
 * própria e verificação própria, sujeita a I2, RBAC, kill switch e auditoria
 * como qualquer outra. Tratá-la como um botão de undo a colocaria fora das
 * guardas — e desfazer errado move tanto dinheiro quanto fazer errado.
 *
 * Os parâmetros saem do estado capturado **antes** da escrita original. Sem
 * ele, "reverter" restauraria um estado que ninguém observou.
 */

export type RevertDerivation =
  | {
      derivable: true;
      parameters: AdActionParameters;
      desiredStatus: AdStatus | null;
    }
  | { derivable: false; reason: string };

export type PreviousState = {
  status?: string | null;
  dailyBudgetMinor?: string | null;
  lifetimeBudgetMinor?: string | null;
} | null;

/** O status canônico que a reversão pede de volta. */
const REVERSIBLE_STATUSES: readonly string[] = ['ACTIVE', 'PAUSED'];

export function deriveRevertParameters(input: {
  actionType: ActionParameterType;
  previousState: PreviousState;
  /** Os parâmetros da ação original — trazem o alvo e a moeda. */
  originalParameters: Record<string, unknown>;
  accountCurrency: string;
  toCanonical: (rawStatus: string) => AdStatus;
}): RevertDerivation {
  if (!input.previousState) {
    return {
      derivable: false,
      reason: 'Não há estado anterior capturado para esta execução.',
    };
  }

  if (isBudgetAction(input.actionType)) {
    const minor = input.previousState.dailyBudgetMinor;

    if (!minor) {
      return {
        derivable: false,
        reason: 'O estado anterior não registrou o orçamento diário.',
      };
    }

    const previous = fromMinorUnits(minor, input.accountCurrency);

    if (previous === null || previous <= 0) {
      return {
        derivable: false,
        reason: 'O orçamento anterior não é um valor restaurável.',
      };
    }

    /**
     * O valor **atual** vira o `previousDailyBudget` da reversão: se alguém
     * reverter a reversão amanhã, é a este número que ela volta. Copiar o campo
     * da ação original faria a segunda reversão restaurar o estado de antes da
     * primeira, pulando um degrau da história.
     */
    return {
      derivable: true,
      desiredStatus: null,
      parameters: {
        ...input.originalParameters,
        schemaVersion: 1,
        dailyBudget: previous,
        previousDailyBudget: numberOr(
          input.originalParameters.dailyBudget,
          previous,
        ),
        currency: input.accountCurrency,
      } as AdActionParameters,
    };
  }

  const status = input.previousState.status;

  if (!status) {
    return {
      derivable: false,
      reason: 'O estado anterior não registrou o status do alvo.',
    };
  }

  const canonical = input.toCanonical(status);

  /**
   * Só `ACTIVE` e `PAUSED` voltam. `ARCHIVED` é o estado que §13.1 declara
   * irreversível, e `UNKNOWN` significa que não soubemos ler — restaurar
   * qualquer um dos dois seria escrever com base numa leitura que não entendemos.
   */
  if (!REVERSIBLE_STATUSES.includes(canonical)) {
    return {
      derivable: false,
      reason: `O estado anterior (${canonical}) não é restaurável por escrita.`,
    };
  }

  return {
    derivable: true,
    desiredStatus: canonical,
    parameters: {
      ...input.originalParameters,
      schemaVersion: 1,
    } as AdActionParameters,
  };
}

/**
 * O tipo de ação que **restaura** o estado anterior.
 *
 * Reverter um `PAUSE_AD` é um `ENABLE_AD`, não um `PAUSE_AD` com parâmetro
 * trocado: a Meta tem caminhos diferentes, e a capability é declarada por tipo.
 * Manter o tipo original faria a reversão ser recusada pela mesma validação que
 * aprovou a ação — ou, pior, aceita e sem efeito.
 */
const INVERSE_ACTION: Partial<
  Record<ActionParameterType, ActionParameterType>
> = {
  PAUSE_AD: 'ENABLE_AD',
  ENABLE_AD: 'PAUSE_AD',
  PAUSE_AD_SET: 'ENABLE_AD_SET',
  ENABLE_AD_SET: 'PAUSE_AD_SET',
  PAUSE_CAMPAIGN: 'ENABLE_CAMPAIGN',
  ENABLE_CAMPAIGN: 'PAUSE_CAMPAIGN',
  ADJUST_AD_SET_BUDGET: 'ADJUST_AD_SET_BUDGET',
  ADJUST_CAMPAIGN_BUDGET: 'ADJUST_CAMPAIGN_BUDGET',
};

export function inverseActionOf(
  type: ActionParameterType,
): ActionParameterType | null {
  return INVERSE_ACTION[type] ?? null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}
