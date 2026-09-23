import type { GuardEvaluation } from 'src/modules/platform-actions/application/services/action-guard-evaluator.service';
import type { ActionExecutionView } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import type { ActionTargetView } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';

/**
 * As três respostas que `POST /ads/{id}/actions` pode dar, montadas fora do use
 * case.
 *
 * Funções puras, e separadas por §16.6: o use case ficou acima do teto de ~150
 * linhas, e o teto existe para que o caminho de escrita continue legível na hora
 * em que alguém o audita depois de um incidente. Montar envelope não é decidir
 * nada — é a parte que mais cresce e a que menos importa entender sob pressão.
 */

/**
 * **`202`, nunca `200`** (§8.4). A resposta afirma que a intenção foi aceita, e
 * carrega os dois estados **sem fundi-los**: é o que permite a tela dizer
 * "pausando…" em vez de "pausado" enquanto a plataforma não confirma.
 */
export function acceptedResponse(input: {
  executionId: string;
  actionId: string;
  target: ActionTargetView;
  verdict: GuardEvaluation;
}) {
  return envelope(
    {
      executionId: input.executionId,
      actionId: input.actionId,
      status: 'QUEUED',
      observedStatus: input.target.observedStatus,
      desiredStatus: input.verdict.desiredStatus,
      scopeWarning: input.verdict.scopeWarning,
    },
    { asOf: new Date().toISOString() },
  );
}

/**
 * O relatório do dry-run: **todos** os bloqueios, não o primeiro.
 *
 * É a diferença entre uma validação que serve para decidir e uma que serve para
 * adivinhar. Quem vai aplicar precisa saber tudo que falta antes de tentar, não
 * descobrir um obstáculo por requisição.
 */
export function dryRunResponse(input: {
  target: ActionTargetView;
  actionType: string;
  level: string;
  targetEntityId: string;
  parameters: unknown;
  verdict: GuardEvaluation;
}) {
  return envelope(
    {
      dryRun: true,
      wouldExecute: input.verdict.allowed,
      blockedBy: input.verdict.allowed ? null : input.verdict.failure,
      plan: {
        adId: input.target.adId,
        actionType: input.actionType,
        level: input.level,
        target: { type: input.level, id: input.targetEntityId },
        parameters: input.parameters,
        scopeWarning: input.verdict.scopeWarning,
        reversible: input.verdict.reversible,
      },
      /**
       * `LOCAL_ONLY` **não** é aprovação da plataforma, e o campo existe para o
       * cliente não confundir as duas — §13.5 exige `PLATFORM` acima de dez
       * itens em lote justamente por isso.
       */
      validationDepth: 'LOCAL_ONLY',
      dailyCap: input.verdict.dailyCap,
      currentState: {
        observedStatus: input.target.observedStatus,
        desiredStatus: input.target.desiredStatus,
        syncState: input.target.syncState,
      },
    },
    { asOf: new Date().toISOString() },
  );
}

/**
 * O replay de A8: devolve o resultado **original**, marcado como tal.
 *
 * Sem `replayed`, um retry por timeout de rede seria indistinguível de uma
 * segunda ação bem-sucedida — e a contagem do usuário divergiria da nossa.
 */
export function replayResponse(execution: ActionExecutionView) {
  return envelope(
    {
      executionId: execution.executionId,
      actionId: execution.actionId,
      status: execution.status,
      observedStatus: execution.observedStatus,
      desiredStatus: execution.desiredStatus,
      replayed: true,
    },
    { asOf: new Date().toISOString() },
  );
}

/** A resposta de uma reversão aceita (§9.6) — ação nova, com o elo declarado. */
export function revertAcceptedResponse(input: {
  executionId: string;
  actionId: string;
  revertsExecutionId: string;
  actionType: string;
  observedStatus: string;
  desiredStatus: string | null;
}) {
  return envelope(
    {
      executionId: input.executionId,
      actionId: input.actionId,
      /**
       * O elo com a original **na resposta**, não só no banco: o cliente
       * precisa saber qual escrita está sendo desfeita para não oferecer
       * "reverter" duas vezes sobre a mesma.
       */
      revertsExecutionId: input.revertsExecutionId,
      actionType: input.actionType,
      status: 'QUEUED',
      observedStatus: input.observedStatus,
      desiredStatus: input.desiredStatus,
    },
    { asOf: new Date().toISOString() },
  );
}
