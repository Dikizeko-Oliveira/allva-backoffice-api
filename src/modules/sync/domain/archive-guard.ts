import { AdAccountSyncHealth, degradationFor } from './account-health';

/**
 * A guarda de arquivamento (§8.2, passo 9) — **a correção central do sync**.
 *
 * "Não visto" só significa "não existe mais" quando **conseguimos ver tudo**.
 * Falha, timeout, paginação incompleta, escopo reduzido ou permissão revogada
 * levam a conta a `UNREACHABLE` e **nenhum anúncio é arquivado**.
 *
 * Sem essa guarda, uma reconexão com escopo menor arquiva milhares de anúncios
 * ativos, fecha todo o desperdício aberto como `STALE` e zera o número de capa
 * sem que nada tenha acontecido com a mídia. O usuário abre o produto e vê que
 * seu problema sumiu — enquanto o dinheiro continua saindo.
 */

/** As etapas de §8.2 que precisam ter concluído para autorizar arquivamento. */
export type IngestStep =
  | 'CREDENTIAL'
  | 'STRUCTURE'
  | 'UPSERT'
  | 'METRICS'
  | 'NORMALIZATION'
  | 'OBSERVED_STATUS'
  | 'ARCHIVE';

export type StepStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export type StepResult = {
  step: IngestStep;
  status: StepStatus;
  /** Quantidade tratada — o que o `SyncOperation.stepResults` reporta. */
  count?: number;
  reason?: string;
};

/**
 * As etapas 4–6 de §8.2, nomeadas. Arquivar exige que **todas** tenham
 * concluído: sem estrutura não sabemos o que existe, sem upsert não sabemos o
 * que foi visto, sem métricas a decisão seria tomada sobre metade do quadro.
 */
const STEPS_REQUIRED_FOR_ARCHIVE: readonly IngestStep[] = [
  'STRUCTURE',
  'UPSERT',
  'METRICS',
];

export type ArchiveVerdict =
  | { allowed: true }
  | { allowed: false; code: ArchiveSuppressionCode; reason: string };

export type ArchiveSuppressionCode =
  | 'INCOMPLETE_RESPONSE'
  | 'STEP_FAILED'
  | 'ACCOUNT_NOT_HEALTHY';

/**
 * Decide se este ingest pode arquivar o que não viu.
 *
 * Função pura e sem exceção: o veredito negativo carrega o motivo porque ele
 * vira alerta `AD_ARCHIVE_SUPPRESSED` sobre a **conta** (⊕1) — na hora em que a
 * guarda dispara, o produto tem de dizer que decidiu não arquivar, e por quê.
 * Uma guarda silenciosa é indistinguível de um bug que esqueceu de arquivar.
 */
export function evaluateArchiveGuard(input: {
  wasComplete: boolean;
  stepResults: StepResult[];
  health: AdAccountSyncHealth;
}): ArchiveVerdict {
  if (!input.wasComplete) {
    return {
      allowed: false,
      code: 'INCOMPLETE_RESPONSE',
      reason:
        'a resposta da plataforma não cobriu o escopo pedido; "não visto" não ' +
        'autoriza concluir "não existe"',
    };
  }

  const failed = STEPS_REQUIRED_FOR_ARCHIVE.filter((step) =>
    input.stepResults.some(
      (result) => result.step === step && result.status !== 'SUCCEEDED',
    ),
  );

  if (failed.length > 0) {
    return {
      allowed: false,
      code: 'STEP_FAILED',
      reason: `etapas não concluídas: ${failed.join(', ')}`,
    };
  }

  const missing = STEPS_REQUIRED_FOR_ARCHIVE.filter(
    (step) => !input.stepResults.some((result) => result.step === step),
  );

  if (missing.length > 0) {
    return {
      allowed: false,
      code: 'STEP_FAILED',
      reason: `etapas não executadas: ${missing.join(', ')}`,
    };
  }

  if (!degradationFor(input.health).archiving) {
    return {
      allowed: false,
      code: 'ACCOUNT_NOT_HEALTHY',
      reason: `conta em ${input.health}: §8.7 proíbe arquivamento`,
    };
  }

  return { allowed: true };
}
