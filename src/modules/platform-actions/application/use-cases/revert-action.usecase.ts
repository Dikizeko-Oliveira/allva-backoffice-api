import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import type { ActionParameterType } from 'src/modules/ads/domain/actions/action-parameters.schema';
import { toCanonicalStatus } from 'src/modules/ads/domain/platform/platform-profiles';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { ActionGuardEvaluatorService } from 'src/modules/platform-actions/application/services/action-guard-evaluator.service';
import { requestDigest } from 'src/modules/platform-actions/domain/idempotency';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { ActionTargetsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import {
  PreviousState,
  deriveRevertParameters,
  inverseActionOf,
} from 'src/modules/platform-actions/domain/revert';
import {
  assertConnected,
  noInverseActionRefusal,
  notRevertibleRefusal,
  revertStateUnavailableRefusal,
  writeInFlightRefusal,
} from 'src/modules/platform-actions/application/errors/write-refusals';
import { PlatformActionsDispatcher } from 'src/modules/platform-actions/infrastructure/queues/platform-actions.dispatcher';
import { revertAcceptedResponse } from 'src/modules/platform-actions/application/presenters/action-execution.presenter';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

const EXECUTION_TTL_MS = 15 * 60 * 1000;

/**
 * `POST /ads/actions/executions/{id}/revert` — §9.6, entrega 12.
 *
 * **Reversão é ação nova.** Origem `REVERT`, execução própria, verificação
 * própria, e sujeita às mesmas guardas: I2, kill switch, consentimento, teto e
 * auditoria. Um caminho de undo que pulasse a cadeia seria a porta pela qual
 * uma escrita entra sem passar por P5 — e desfazer errado move tanto dinheiro
 * quanto fazer errado.
 *
 * **A permissão é a da ação inversa.** Reverter um ajuste de orçamento é ajustar
 * orçamento; exigir apenas `actions:execute` daria a um `ANALYST` a capacidade
 * de mexer em orçamento pela porta dos fundos.
 */
@Injectable()
export class RevertActionUseCase {
  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly targets: ActionTargetsRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly guards: ActionGuardEvaluatorService,
    private readonly dispatcher: PlatformActionsDispatcher,
    private readonly audit: AuditLogService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    executionId: string;
    idempotencyKey: string;
    correlationId: string | null;
  }) {
    const original = await this.executions.findExecution({
      organizationId: input.organizationId,
      executionId: input.executionId,
    });

    if (!original) throw new NotFoundException('Execução não encontrada');

    /**
     * Só escrita que **aconteceu** se reverte. Uma execução recusada não mudou
     * nada, e "reverter" nela escreveria um estado que a plataforma nunca teve.
     */
    if (original.status !== 'SUCCEEDED' || original.dryRun) {
      throw notRevertibleRefusal({
        status: original.status,
        dryRun: original.dryRun,
      });
    }

    const inverse = inverseActionOf(original.actionType as ActionParameterType);

    if (!inverse) throw noInverseActionRefusal(original.actionType);

    const target = await this.targets.findTarget({
      organizationId: input.organizationId,
      adId: original.adId,
    });

    if (!target) throw new NotFoundException('Anúncio não encontrado');

    // Sem credencial não há para onde reverter (P10), e o motivo é outro que
    // não "o anúncio sumiu".
    assertConnected(target);

    const derivation = deriveRevertParameters({
      actionType: inverse,
      previousState:
        ((await this.executions.loadForExecution(input.executionId))
          ?.previousState as PreviousState) ?? null,
      originalParameters: (original.parameters ?? {}) as Record<
        string,
        unknown
      >,
      accountCurrency: target.accountCurrency,
      toCanonical: (raw) => toCanonicalStatus(target.platform, raw),
    });

    if (!derivation.derivable) {
      throw revertStateUnavailableRefusal(derivation.reason);
    }

    const level = this.registry.levelOf(inverse);
    const targetEntityId = this.registry.targetIdFor(level, target)!;

    // A mesma cadeia de P5 da escrita direta. Reverter não é privilegiado.
    const verdict = await this.guards.evaluate({
      organizationId: input.organizationId,
      target,
      actionType: inverse,
      level,
      targetEntityId,
    });

    if (!verdict.allowed) throw new DomainError(verdict.failure);

    const enqueued = await this.executions.enqueueRevert({
      originalExecutionId: input.executionId,
      organizationId: input.organizationId,
      requestedByAccountId: input.accountId,
      actionType: inverse,
      parameters: derivation.parameters,
      previousState: {
        status: target.observedStatus,
        capturedAt: new Date().toISOString(),
      },
      idempotencyKey: input.idempotencyKey,
      requestDigest: requestDigest({
        adId: original.adId,
        actionType: `REVERT:${inverse}`,
        targetEntityType: level,
        targetEntityId,
        parameters: derivation.parameters,
        dryRun: false,
      }),
      correlationId: input.correlationId,
      expiresAt: new Date(Date.now() + EXECUTION_TTL_MS),
      desiredStatus: derivation.desiredStatus,
    });

    if (enqueued.kind === 'WRITE_IN_FLIGHT') {
      throw writeInFlightRefusal(enqueued.inFlightExecutionId);
    }

    if (enqueued.kind === 'IDEMPOTENT_REPLAY') {
      return envelope(
        { executionId: enqueued.executionId, replayed: true },
        { asOf: new Date().toISOString() },
      );
    }

    await this.dispatcher.perform({
      ctx: {
        correlationId: input.correlationId ?? enqueued.executionId,
        causationId: null,
      },
      executionId: enqueued.executionId,
      attempt: 1,
    });

    await this.audit.record({
      event: 'ad.action.requested',
      entityType: 'ActionExecution',
      entityId: enqueued.executionId,
      actorId: input.accountId,
      organizationId: input.organizationId,
      metadata: {
        adId: original.adId,
        actionType: inverse,
        origin: 'REVERT',
        revertsExecutionId: input.executionId,
      },
    });

    return revertAcceptedResponse({
      executionId: enqueued.executionId,
      actionId: enqueued.actionId,
      revertsExecutionId: input.executionId,
      actionType: inverse,
      observedStatus: target.observedStatus,
      desiredStatus: derivation.desiredStatus,
    });
  }
}
