import { Injectable, NotFoundException } from '@nestjs/common';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import {
  authorshipOf,
  checkAuthoredContent,
} from 'src/modules/platform-actions/domain/authored-content';
import {
  contentDigest,
  requestDigest,
  resolveIdempotency,
} from 'src/modules/platform-actions/domain/idempotency';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { ActionTargetsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { ActionEnqueueService } from 'src/modules/platform-actions/application/services/action-enqueue.service';
import { ActionGuardEvaluatorService } from 'src/modules/platform-actions/application/services/action-guard-evaluator.service';
import {
  assertConnected,
  authoredContentRefusal,
  dryRunOnlyRefusal,
  idempotencyReuseRefusal,
  targetAbsentRefusal,
} from 'src/modules/platform-actions/application/errors/write-refusals';
import {
  acceptedResponse,
  dryRunResponse,
} from 'src/modules/platform-actions/application/presenters/action-execution.presenter';
import type { ExecuteActionInput } from 'src/modules/platform-actions/application/use-cases/execute-action.input';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * `POST /ads/{id}/actions` — **o único caminho de escrita** (§13.5, P5).
 *
 * A ordem é o gate de saída do sprint: *"nenhuma ação executa sem RBAC ok, kill
 * switch off, consentimento registrado, revalidação e audit gravado"*. RBAC fica
 * no guard HTTP; os outros quatro passam por aqui, num caminho só — um teste
 * "por caminho" só é escrevível se houver **um**.
 *
 * **Dry-run avalia tudo e não lança.** É o que dá utilidade real à validação:
 * parar no primeiro obstáculo faria o usuário descobrir os bloqueios um por vez,
 * um pedido de cada vez. A escrita real, essa sim, para no primeiro.
 */
@Injectable()
export class ExecuteActionUseCase {
  constructor(
    private readonly targets: ActionTargetsRepositoryInterface,
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly guards: ActionGuardEvaluatorService,
    private readonly enqueueService: ActionEnqueueService,
    private readonly env: EnvService,
  ) {}

  async execute(input: ExecuteActionInput) {
    const dryRunOnly = this.env.get('PLATFORM_ACTIONS_DRY_RUN_ONLY');
    const dryRun = input.body.dryRun ?? dryRunOnly;

    // A tranca de RP5 precede tudo (ver `dryRunOnlyRefusal`).
    if (dryRunOnly && input.body.dryRun === false) throw dryRunOnlyRefusal();

    const target = await this.targets.findTarget({
      organizationId: input.organizationId,
      adId: input.adId,
    });

    if (!target) throw new NotFoundException('Anúncio não encontrado');

    // O anúncio existe; o que falta é a credencial da conta (P10). Recusar como
    // "não encontrado" mandaria o usuário procurar o anúncio, não a integração.
    assertConnected(target);

    const level = this.registry.levelOf(input.body.type);
    const targetEntityId = this.registry.targetIdFor(level, target);

    if (!targetEntityId) {
      throw targetAbsentRefusal(
        platformProfile(target.platform).hierarchy.adSetLabel,
      );
    }

    const digest = requestDigest({
      adId: input.adId,
      actionType: input.body.type,
      targetEntityType: level,
      targetEntityId,
      parameters: input.body.parameters,
      dryRun,
    });

    /**
     * O replay é checado **antes** das guardas: um retry legítimo devolve o
     * resultado original mesmo que o mundo tenha mudado no intervalo. Reavaliar
     * ali transformaria a segunda chamada da mesma ação em erro — e o cliente,
     * que só reenviou por timeout de rede, registraria uma falha que não houve.
     */
    const idempotency = resolveIdempotency({
      existing: await this.executions.findByIdempotencyKey({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      }),
      digest,
    });

    if (idempotency.kind === 'REUSED_WITH_DIFFERENT_PAYLOAD') {
      throw idempotencyReuseRefusal();
    }

    if (idempotency.kind === 'REPLAY') {
      return this.enqueueService.replayOf(
        input.organizationId,
        idempotency.executionId,
      );
    }

    const verdict = await this.guards.evaluate({
      organizationId: input.organizationId,
      target,
      actionType: input.body.type,
      level,
      targetEntityId,
    });

    if (dryRun) {
      return {
        executionId: null,
        actionId: null,
        body: dryRunResponse({
          target,
          actionType: input.body.type,
          level,
          targetEntityId,
          parameters: input.body.parameters,
          verdict,
        }),
      };
    }

    if (!verdict.allowed) throw new DomainError(verdict.failure);

    /**
     * R14 depois das guardas de P5 e antes de gravar: uma recusa por texto não
     * confirmado não deve chegar antes de "sua organização desligou as ações" —
     * a segunda é mais decisiva, e resolver a primeira não destravaria nada.
     */
    const authorship = checkAuthoredContent({
      actionType: input.body.type,
      ...authorshipOf(input.body.parameters),
      confirmedContentDigest: input.body.confirmedContentDigest,
      batchSize: 1,
      digestOf: contentDigest,
    });

    if (authorship) throw authoredContentRefusal(authorship);

    const outcome = await this.enqueueService.enqueue({
      organizationId: input.organizationId,
      requestedByAccountId: input.accountId,
      target,
      actionType: input.body.type,
      level,
      targetEntityId,
      parameters: input.body.parameters,
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
      correlationId: input.correlationId,
      verdict,
      origin: input.origin,
      recommendationId: input.recommendationId,
      existingActionId: input.existingActionId,
    });

    if (outcome.kind === 'REPLAY') {
      return this.enqueueService.replayOf(
        input.organizationId,
        outcome.executionId,
      );
    }

    return {
      executionId: outcome.executionId,
      actionId: outcome.actionId,
      body: acceptedResponse({
        executionId: outcome.executionId,
        actionId: outcome.actionId,
        target,
        verdict,
      }),
    };
  }
}
