import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { SecurityAuditLogService } from 'src/modules/security/application';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PlatformCredentialProvider } from 'src/modules/platform-clients/domain/ports/platform-credential.provider';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import type {
  AdActionCommand,
  ExecutionContext,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';
import {
  ActionExecutionsRepositoryInterface,
  ExecutableAction,
} from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import {
  DomainEventBus,
  emitContext,
} from 'src/shared/domain/events/domain-event-bus';
import { authorshipOf } from 'src/modules/platform-actions/domain/authored-content';
import { contentDigest } from 'src/modules/platform-actions/domain/idempotency';
import type { ActionExecutionStatus } from 'src/shared/domain/events/domain-event-map';
import type { JobContext } from 'src/shared/domain/events/job-context';
import { RecommendationSettlementService } from 'src/modules/platform-actions/application/services/recommendation-settlement.service';

/** §13.4 passo 5 — três tentativas, e a terceira é a última. */
const MAX_ATTEMPTS = 3;

/**
 * O desfecho carrega o anúncio e o tenant porque o worker precisa deles para
 * pedir a releitura ao `sync` — e buscá-los de novo lá seria uma segunda
 * consulta para um dado que este serviço acabou de ter em mãos.
 */
export type SettledRef = {
  organizationId: string;
  adId: string;
  /**
   * P3 — a origem viaja com o desfecho. Sem ela, saber se esta execução fecha
   * um plano de recomendação exigiria uma segunda consulta a cada escrita, e a
   * consulta seria idêntica à que acabou de acontecer.
   */
  recommendationId: string | null;
  requestedByAccountId: string | null;
};

export type PerformOutcome =
  | ({ kind: 'SETTLED'; status: string } & SettledRef)
  | ({ kind: 'VERIFY'; delayMs: number } & SettledRef)
  | { kind: 'RETRY'; delayMs: number }
  | { kind: 'SKIPPED'; reason: string };

/**
 * O worker de execução (§13.4), como serviço.
 *
 * A sequência é a do documento, e a ordem importa em dois pontos que não são
 * óbvios:
 *
 * **O kill switch é reconferido aqui.** Ele foi verificado no `POST`, mas entre
 * aceitar a intenção e escrever passam segundos ou minutos — e o propósito
 * inteiro de um kill switch é agir nesse intervalo. Um worker que confiasse na
 * checagem da requisição transformaria "pare tudo agora" em "pare tudo que
 * ainda não foi enfileirado".
 *
 * **`previousState` é recapturado da plataforma antes do `POST`.** O do enqueue
 * é a leitura local, que pode estar velha; sem a leitura fresca, a reversão de
 * §9.6 restauraria um estado que já não era o vigente quando escrevemos.
 */
@Injectable()
export class PerformActionService {
  private readonly logger = new Logger(PerformActionService.name);

  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly credentials: PlatformCredentialProvider,
    private readonly audit: AuditLogService,
    private readonly security: SecurityAuditLogService,
    private readonly events: DomainEventBus,
    private readonly settlement: RecommendationSettlementService,
  ) {}

  /**
   * Executa e, quando o desfecho é terminal, **reavalia o plano da recomendação**
   * que a originou (§9.5 passo 5).
   *
   * A reavaliação fica aqui, e não no worker, porque é o desfecho da execução que
   * a dispara — não o roteamento do próximo job. Um `RETRY` não reavalia nada: a
   * escrita ainda vai acontecer, e declarar o plano assentado no meio de uma
   * tentativa marcaria como aplicada uma recomendação que ainda pode falhar.
   */
  async perform(input: {
    executionId: string;
    attempt: number;
    ctx: JobContext;
  }): Promise<PerformOutcome> {
    const outcome = await this.run(input);

    if (outcome.kind === 'RETRY' || outcome.kind === 'SKIPPED') return outcome;

    // Dry-run não conta: ele não escreveu nada, e um plano "aplicado" por
    // validação seria a afirmação mais cara que o produto pode fazer de graça.
    const dryRun = outcome.kind === 'SETTLED' && outcome.status === 'DRY_RUN';

    if (outcome.recommendationId && !dryRun) {
      await this.settlement.onExecutionSettled({
        organizationId: outcome.organizationId,
        recommendationId: outcome.recommendationId,
        requestedByAccountId: outcome.requestedByAccountId,
        ctx: input.ctx,
      });
    }

    return outcome;
  }

  private async run(input: {
    executionId: string;
    attempt: number;
    ctx: JobContext;
  }): Promise<PerformOutcome> {
    const action = await this.executions.loadForExecution(input.executionId);

    if (!action) {
      return { kind: 'SKIPPED', reason: 'EXECUTION_NOT_FOUND' };
    }

    if (action.status !== 'QUEUED') {
      // Já terminou, já está correndo, ou o reaper a recolheu. Reexecutar aqui
      // seria a segunda escrita que I2 existe para impedir.
      return { kind: 'SKIPPED', reason: `STATUS_${action.status}` };
    }

    if (!action.organizationActionsEnabled) {
      await this.settleAsFailed(action, {
        errorCode: 'ORGANIZATION_ACTIONS_DISABLED',
        errorMessage:
          'O kill switch da organização foi acionado antes desta escrita.',
      });
      return { kind: 'SETTLED', status: 'CANCELLED', ...refOf(action) };
    }

    if (
      !(await this.executions.markRunning({
        executionId: action.executionId,
        attempt: input.attempt,
      }))
    ) {
      return { kind: 'SKIPPED', reason: 'ALREADY_CLAIMED' };
    }

    const gateway = this.registry.gatewayFor(action.platform as Platform);

    if (!gateway) {
      await this.settleAsFailed(action, {
        errorCode: 'ACTION_UNSUPPORTED',
        errorMessage: `Não há gateway de escrita para ${action.platform}.`,
        status: 'UNSUPPORTED',
      });
      return { kind: 'SETTLED', status: 'UNSUPPORTED', ...refOf(action) };
    }

    const command = this.commandOf(action);
    const ctx = await this.contextOf(action, input.attempt);

    /**
     * Dry-run para aqui: valida, registra a profundidade e encerra sem tocar na
     * plataforma (§13.4 passo 3).
     */
    if (action.dryRun) {
      const validation = await gateway.validate(command);
      await this.executions.settle({
        executionId: action.executionId,
        status: validation.valid ? 'SUCCEEDED' : 'FAILED',
        errorCode: validation.failures.at(0)?.code ?? null,
        errorMessage: validation.failures.at(0)?.message ?? null,
        responsePayload: { validation },
      });
      return { kind: 'SETTLED', status: 'DRY_RUN', ...refOf(action) };
    }

    // A leitura fresca que a reversão vai usar. Falhar aqui não impede escrever:
    // ficamos com o `previousState` local, que é pior mas não é nada.
    const observed = await gateway.observe(command, ctx).catch(() => null);

    const result = await gateway.execute(command, ctx);

    /**
     * **A plataforma criou, e a sequência não terminou.** Nunca volta à fila:
     * repetir uma criação que já aconteceu criaria outra entidade.
     *
     * O id criado é gravado mesmo assim — é o que a linhagem e o alerta usam
     * para apontar o anúncio que precisa de atenção. E a trilha de segurança
     * sobe para `critical` quando ele pode estar veiculando: uma ação da Allva
     * não pode aumentar gasto sem que alguém fique sabendo.
     */
    if (result.status === 'PARTIALLY_COMPLETED') {
      const exposureRisk = result.exposureRisk === true;

      await this.executions.settle({
        executionId: action.executionId,
        status: 'PARTIALLY_COMPLETED',
        errorCode: result.errorCode ?? 'PARTIALLY_COMPLETED',
        errorMessage: result.errorMessage ?? null,
        responsePayload: {
          result: result.raw,
          observedBefore: observed,
          exposureRisk,
        },
        resultPlatformEntityId: result.platformEntityId ?? null,
        clearDesiredStatus: true,
      });

      await this.recordAudit(
        action,
        'ad.action.failed',
        {
          partiallyCompleted: true,
          exposureRisk,
          platformEntityId: result.platformEntityId ?? null,
          errorCode: result.errorCode ?? 'PARTIALLY_COMPLETED',
        },
        exposureRisk ? 'critical' : 'warning',
      );
      this.emit(
        action,
        input.ctx,
        'PARTIALLY_COMPLETED',
        result.platformEntityId ?? null,
        exposureRisk,
      );

      return {
        kind: 'SETTLED',
        status: 'PARTIALLY_COMPLETED',
        ...refOf(action),
      };
    }

    if (result.status === 'FAILED' && result.retryable) {
      if (input.attempt < MAX_ATTEMPTS) {
        return { kind: 'RETRY', delayMs: backoffWithJitter(input.attempt) };
      }
    }

    if (result.status === 'SUCCEEDED') {
      await this.executions.settle({
        executionId: action.executionId,
        status: 'SUCCEEDED',
        responsePayload: { result: result.raw, observedBefore: observed },
        resultPlatformEntityId: result.platformEntityId ?? null,
      });

      await this.recordAudit(action, 'ad.action.executed', {
        platformEntityId: result.platformEntityId ?? null,
      });
      this.emit(
        action,
        input.ctx,
        'SUCCEEDED',
        result.platformEntityId ?? null,
      );

      /**
       * **`desiredStatus` continua preenchido**: a plataforma aceitou, e nada
       * ainda observou o efeito. Limpá-lo aqui faria a tela dizer "pausado" com
       * base na nossa própria afirmação — que é o que a escada de verificação
       * existe para não aceitar.
       */
      return { kind: 'VERIFY', delayMs: 90_000, ...refOf(action) };
    }

    const executionStatus: ActionExecutionStatus =
      result.status === 'REJECTED_BY_PLATFORM'
        ? 'REJECTED_BY_PLATFORM'
        : result.status === 'UNSUPPORTED'
          ? 'UNSUPPORTED'
          : 'FAILED';

    await this.settleAsFailed(action, {
      errorCode: result.errorCode ?? 'UNKNOWN',
      errorMessage: result.errorMessage ?? null,
      status: executionStatus,
    });

    await this.recordAudit(action, 'ad.action.failed', {
      errorCode: result.errorCode ?? 'UNKNOWN',
    });
    this.emit(action, input.ctx, executionStatus, null);

    return { kind: 'SETTLED', status: result.status, ...refOf(action) };
  }

  private async settleAsFailed(
    action: ExecutableAction,
    input: {
      errorCode: string;
      errorMessage: string | null;
      status?: 'FAILED' | 'REJECTED_BY_PLATFORM' | 'UNSUPPORTED' | 'CANCELLED';
    },
  ): Promise<void> {
    await this.executions.settle({
      executionId: action.executionId,
      status: input.status ?? 'CANCELLED',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      /**
       * A escrita não aconteceu: o estado otimista sai. O `syncState` fica em
       * `PENDING_WRITE` até o `sync` reler o anúncio — §3.5 não deixa o escritor
       * declarar o que a plataforma faz, e depois de uma recusa nós sabemos
       * menos, não mais.
       */
      clearDesiredStatus: true,
    });
  }

  private commandOf(action: ExecutableAction): AdActionCommand {
    return {
      type: action.actionType,
      level: action.level,
      target: {
        type: action.targetEntityType,
        internalId: action.targetEntityId,
        externalId: action.targetExternalId,
      },
      parameters: action.parameters as AdActionParameters,
      accountCurrency: action.accountCurrency,
    };
  }

  private async contextOf(
    action: ExecutableAction,
    attempt: number,
  ): Promise<ExecutionContext> {
    const credential = await this.credentials.resolveByIntegration(
      action.integrationId,
    );

    return {
      idempotencyKey: action.idempotencyKey,
      integrationId: action.integrationId,
      externalAccountId: action.externalAccountId,
      accessToken: credential.accessToken,
      correlationId: action.correlationId,
      attempt,
    };
  }

  /**
   * Entrega 15 — **as duas trilhas, sempre**.
   *
   * A de negócio responde "o que aconteceu com este anúncio"; a de segurança
   * responde "quem, de onde, e o que mais essa conta fez naquela janela". Elas
   * têm retenções diferentes e consumidores diferentes, e gravar só a primeira
   * obrigaria toda investigação de incidente a cruzar por `entityId` uma trilha
   * que não guarda sessão nem origem.
   *
   * Nenhuma das duas pode derrubar a execução: os dois serviços engolem falha de
   * persistência por contrato. Uma escrita em mídia paga que já aconteceu não
   * pode ser desfeita porque o log falhou.
   */
  private async recordAudit(
    action: ExecutableAction,
    event: 'ad.action.executed' | 'ad.action.failed',
    metadata: Record<string, unknown>,
    failureSeverity: 'warning' | 'critical' = 'warning',
  ): Promise<void> {
    const shared = {
      adId: action.adId,
      actionType: action.actionType,
      platform: action.platform,
      origin: action.origin,
      ...metadata,
    };

    await Promise.all([
      this.audit.record({
        event,
        entityType: 'ActionExecution',
        entityId: action.executionId,
        actorId: action.requestedByAccountId,
        organizationId: action.organizationId,
        metadata: shared,
      }),
      this.security.record({
        event:
          event === 'ad.action.executed'
            ? 'platform_write.executed'
            : 'platform_write.failed',
        // Uma escrita que deu certo é evento informativo; uma que falhou pode
        // ser o primeiro sinal de credencial comprometida ou de integração
        // sequestrada, e merece subir na triagem.
        severity: event === 'ad.action.executed' ? 'info' : failureSeverity,
        accountId: action.requestedByAccountId,
        organizationId: action.organizationId,
        metadata: { ...shared, executionId: action.executionId },
      }),
    ]);
  }

  private emit(
    action: ExecutableAction,
    ctx: JobContext,
    status: ActionExecutionStatus,
    resultPlatformEntityId: string | null,
    exposureRisk = false,
  ): void {
    this.events.emitFrom(
      emitContext(ctx, action.organizationId),
      'action.executed',
      {
        adId: action.adId,
        actionId: action.actionId,
        executionId: action.executionId,
        origin: action.origin,
        status,
        resultPlatformEntityId,
        ...(exposureRisk ? { exposureRisk: true } : {}),
        actionType: action.actionType,
        /**
         * O **dígito** do texto que foi ao ar — nunca o texto.
         *
         * É o que permite a `creative-lab` casar esta execução com a variação de
         * copy que a originou, sem que conteúdo de marca trafegue no barramento
         * e sem que o executor precise conhecer quem produziu o texto. Fazer o
         * contrário — o executor chamando um módulo de conteúdo — inverteria a
         * mesma relação que já foi recusada em `recommendations`: uma ação
         * `USER_DIRECT` não tem produtor nenhum por trás.
         */
        appliedContentDigest: appliedDigestOf(action),
      },
    );
  }
}

/**
 * O dígito do texto aplicado, nas ações que carregam texto.
 *
 * Reusa `contentDigest` — o mesmo que a guarda de R14 já calcula para conferir a
 * confirmação — em vez de um hash próprio. Dois hashes do mesmo texto divergem
 * no primeiro ajuste de normalização, e o que erra é o que ninguém exercita.
 */
function appliedDigestOf(action: ExecutableAction): string | null {
  const { content } = authorshipOf(
    action.parameters as Record<string, unknown>,
  );

  return content ? contentDigest(content) : null;
}

/**
 * Backoff exponencial **com jitter** (§13.4).
 *
 * Sem o jitter, N execuções que falharam pela mesma indisponibilidade da
 * plataforma voltam juntas no mesmo milissegundo — e a segunda rajada é maior
 * que a primeira, porque a fila acumulou enquanto a plataforma estava fora.
 */
function refOf(action: ExecutableAction): SettledRef {
  return {
    organizationId: action.organizationId,
    adId: action.adId,
    recommendationId: action.recommendationId,
    requestedByAccountId: action.requestedByAccountId,
  };
}

export function backoffWithJitter(attempt: number): number {
  const base = 30_000 * 2 ** (attempt - 1);
  return Math.round(base * (0.5 + Math.random()));
}
