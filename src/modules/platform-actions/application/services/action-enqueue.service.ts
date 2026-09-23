import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditLogService } from 'src/modules/audit/application';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type {
  ActionLevel,
  AdActionType,
} from 'src/modules/ads/domain/platform/platform-profile';
import type { GuardEvaluation } from 'src/modules/platform-actions/application/services/action-guard-evaluator.service';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import type { ActionTargetView } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { replayResponse } from 'src/modules/platform-actions/application/presenters/action-execution.presenter';
import { PlatformActionsDispatcher } from 'src/modules/platform-actions/infrastructure/queues/platform-actions.dispatcher';
import type { AdActionOrigin } from 'src/shared/domain/events/domain-event-map';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** `appliedAt + 15 min` (C2). Mede a execução, jamais a verificação. */
const EXECUTION_TTL_MS = 15 * 60 * 1000;

export type EnqueueOutcome =
  | { kind: 'ENQUEUED'; executionId: string; actionId: string }
  | { kind: 'REPLAY'; executionId: string };

/**
 * **Persistir a intenção aceita** — plano, execução e estado otimista.
 *
 * Separado do use case porque tem uma responsabilidade inteira e um modo de
 * falha próprio: os dois índices que podem recusar a linha
 * (`action_executions_inflight_unique` e `(organization_id, idempotency_key)`)
 * chegam aqui como conflito do banco e saem como erro tipado de §7.0.4. É o
 * banco — não o código — quem arbitra a corrida, e traduzir a arbitragem é
 * trabalho suficiente para justificar um lugar.
 */
@Injectable()
export class ActionEnqueueService {
  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly dispatcher: PlatformActionsDispatcher,
    private readonly audit: AuditLogService,
  ) {}

  async enqueue(input: {
    organizationId: string;
    requestedByAccountId: string;
    target: ActionTargetView;
    actionType: AdActionType;
    level: ActionLevel;
    targetEntityId: string;
    parameters: unknown;
    idempotencyKey: string;
    requestDigest: string;
    correlationId: string | null;
    verdict: GuardEvaluation;
    /** P3 — origem declarada, nunca assumida. `USER_DIRECT` é só o default. */
    origin?: AdActionOrigin;
    recommendationId?: string | null;
    /** A `AdAction` do plano, quando aplicar é executar o que já foi gravado. */
    existingActionId?: string | null;
  }): Promise<EnqueueOutcome> {
    const { target, verdict } = input;

    const enqueued = await this.executions.enqueue({
      organizationId: input.organizationId,
      adId: target.adId,
      accountId: target.accountId,
      requestedByAccountId: input.requestedByAccountId,
      actionType: input.actionType,
      level: input.level,
      targetEntityType: input.level,
      targetEntityId: input.targetEntityId,
      parameters: input.parameters as AdActionParameters,
      origin: input.origin ?? 'USER_DIRECT',
      recommendationId: input.recommendationId ?? null,
      existingActionId: input.existingActionId ?? null,
      scopeWarning: verdict.scopeWarning,
      reversible: verdict.reversible,
      /**
       * Capturado **antes** de qualquer escrita (§13.5). É a leitura local; a da
       * plataforma chega no worker, imediatamente antes do `POST`. Ter as duas é
       * o que mantém a reversão possível mesmo quando a plataforma não responde
       * na hora de executar.
       */
      previousState: {
        status: target.observedStatus,
        capturedAt: new Date().toISOString(),
      },
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      dryRun: false,
      correlationId: input.correlationId,
      expiresAt: new Date(Date.now() + EXECUTION_TTL_MS),
      desiredStatus: verdict.desiredStatus,
    });

    if (enqueued.kind === 'WRITE_IN_FLIGHT') {
      throw new DomainError({
        code: 'WRITE_IN_FLIGHT',
        category: 'WRITE_IN_FLIGHT',
        message: 'Já existe uma escrita em andamento sobre este alvo.',
        details: { inFlightExecutionId: enqueued.inFlightExecutionId },
        remediation:
          'Aguarde a execução em voo terminar — ela vence em 15 minutos.',
      });
    }

    if (enqueued.kind === 'IDEMPOTENT_REPLAY') {
      return { kind: 'REPLAY', executionId: enqueued.executionId };
    }

    /**
     * A fila **depois** da linha, sempre. O worker carrega a execução pelo id,
     * e publicar antes do commit abriria a janela em que ele a busca e não a
     * encontra — um `EXECUTION_NOT_FOUND` para uma ação que o usuário acabou de
     * pedir e que o banco vai gravar meio milissegundo depois.
     */
    await this.dispatcher.perform({
      ctx: {
        correlationId: input.correlationId ?? randomUUID(),
        causationId: null,
      },
      executionId: enqueued.executionId,
      attempt: 1,
    });

    /**
     * A trilha registra o **pedido**, não só o desfecho. Uma execução que trava
     * na fila também precisa ter autor, alvo e horário reconstruíveis — e
     * sobretudo ela: um desfecho que nunca chegou é o caso em que a pergunta
     * "quem mandou isso?" mais aparece.
     */
    await this.audit.record({
      event: 'ad.action.requested',
      entityType: 'ActionExecution',
      entityId: enqueued.executionId,
      actorId: input.requestedByAccountId,
      organizationId: input.organizationId,
      metadata: {
        adId: target.adId,
        actionType: input.actionType,
        level: input.level,
        targetEntityId: input.targetEntityId,
        platform: target.platform,
        // P3 na trilha: sem a origem, uma escrita nascida de recomendação é
        // indistinguível de uma que alguém digitou — e é a distinção que o
        // dataset de acurácia de P8 mede.
        origin: input.origin ?? 'USER_DIRECT',
        recommendationId: input.recommendationId ?? null,
      },
    });

    return {
      kind: 'ENQUEUED',
      executionId: enqueued.executionId,
      actionId: enqueued.actionId,
    };
  }

  /**
   * A resposta de um replay legítimo (A8).
   *
   * Mora aqui, e não no use case, porque replay **é** parte do contrato de
   * enfileiramento: a mesma chave devolve o resultado da execução original. Quem
   * enfileira é quem sabe o que "já enfileirado" significa.
   */
  async replayOf(organizationId: string, executionId: string) {
    const execution = await this.executions.findExecution({
      organizationId,
      executionId,
    });

    if (!execution) throw new NotFoundException('Execução não encontrada');

    return {
      executionId,
      actionId: execution.actionId,
      body: replayResponse(execution),
    };
  }
}
