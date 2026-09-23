import { Injectable, Logger } from '@nestjs/common';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import { toCanonicalStatus } from 'src/modules/ads/domain/platform/platform-profiles';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PlatformCredentialProvider } from 'src/modules/platform-clients/domain/ports/platform-credential.provider';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { verifyWrite } from 'src/modules/platform-actions/domain/verification-ladder';
import {
  DomainEventBus,
  emitContext,
} from 'src/shared/domain/events/domain-event-bus';
import type { JobContext } from 'src/shared/domain/events/job-context';

export type VerifyOutcome =
  | { kind: 'DONE'; result: string; organizationId: string; adId: string }
  | { kind: 'RETRY'; delayMs: number }
  | { kind: 'SKIPPED'; reason: string };

/**
 * Um degrau da escada (§13.4, entrega 7).
 *
 * **Ler a plataforma aqui não autoriza mexer no `syncState`.** §3.5 dá a
 * `platform-actions` uma transição só — entrar em `PENDING_WRITE` — e a
 * proibição de sair existe para que o escritor não declare o próprio sucesso.
 * A verificação registra o que viu em `ActionExecution` e emite `action.verified`;
 * quem move o anúncio de volta a `IN_SYNC` é o `sync`, relendo o anúncio, e é
 * ele que este serviço pede.
 */
@Injectable()
export class VerifyActionService {
  private readonly logger = new Logger(VerifyActionService.name);

  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly credentials: PlatformCredentialProvider,
    private readonly events: DomainEventBus,
  ) {}

  async verify(input: {
    executionId: string;
    ctx: JobContext;
  }): Promise<VerifyOutcome> {
    const action = await this.executions.loadForExecution(input.executionId);

    if (!action) return { kind: 'SKIPPED', reason: 'EXECUTION_NOT_FOUND' };

    /**
     * Só escrita bem-sucedida tem o que verificar. Uma recusa já respondeu a
     * pergunta, e uma execução ainda em voo seria verificada contra um efeito
     * que ninguém pediu.
     */
    if (action.status !== 'SUCCEEDED') {
      return { kind: 'SKIPPED', reason: `STATUS_${action.status}` };
    }

    const gateway = this.registry.gatewayFor(action.platform as Platform);
    if (!gateway) return { kind: 'SKIPPED', reason: 'NO_GATEWAY' };

    const attempt = action.verificationAttempt + 1;

    const observed = await gateway
      .observe(
        {
          type: action.actionType,
          level: action.level,
          target: {
            type: action.targetEntityType,
            internalId: action.targetEntityId,
            externalId: action.targetExternalId,
          },
          parameters: action.parameters as AdActionParameters,
          accountCurrency: action.accountCurrency,
        },
        {
          idempotencyKey: action.idempotencyKey,
          integrationId: action.integrationId,
          externalAccountId: action.externalAccountId,
          accessToken: (
            await this.credentials.resolveByIntegration(action.integrationId)
          ).accessToken,
          correlationId: action.correlationId,
          attempt,
        },
      )
      .catch((error: unknown) => {
        this.logger.warn(
          `action.verify_read_failed execution=${action.executionId} attempt=${attempt}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });

    const { outcome, retryInMs } = verifyWrite({
      desiredStatus: action.desiredStatus,
      observed,
      toCanonical: (raw) => toCanonicalStatus(action.platform as Platform, raw),
      attempt,
    });

    await this.executions.recordVerification({
      executionId: action.executionId,
      attempt,
      result: outcome,
      // Só há instante de verificação quando de fato se verificou algo. Carimbar
      // `verifiedAt` num degrau inconclusivo diria que houve resposta.
      verifiedAt: outcome === 'INCONCLUSIVE' ? null : new Date(),
    });

    this.events.emitFrom(
      emitContext(input.ctx, action.organizationId),
      'action.verified',
      {
        adId: action.adId,
        executionId: action.executionId,
        verificationResult: outcome,
      },
    );

    if (retryInMs !== null) return { kind: 'RETRY', delayMs: retryInMs };

    return {
      kind: 'DONE',
      result: outcome,
      organizationId: action.organizationId,
      adId: action.adId,
    };
  }
}
