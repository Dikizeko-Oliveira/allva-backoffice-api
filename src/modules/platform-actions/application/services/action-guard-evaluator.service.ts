import { Injectable } from '@nestjs/common';
import type {
  ActionLevel,
  AdActionType,
} from 'src/modules/ads/domain/platform/platform-profile';
import {
  platformProfile,
  unitLabelOf,
} from 'src/modules/ads/domain/platform/platform-profiles';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import {
  ActionAvailability,
  resolveAvailability,
} from 'src/modules/platform-actions/domain/availability';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { ActionTargetsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import type { ConnectedActionTarget } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { ActionWriteSettingsReader } from 'src/modules/platform-actions/domain/ports/action-write-settings.reader';
import { WriteConsentRepositoryInterface } from 'src/modules/platform-actions/domain/ports/write-consent.repository';
import {
  PlanEntitlementState,
  WriteGuardVerdict,
  evaluateWriteGuards,
} from 'src/modules/platform-actions/domain/write-guards';
import { featureFor } from 'src/modules/platform-actions/domain/rbac/action-plan-entitlements';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/** O estado otimista que cada ação declara no anúncio (§8.4). */
const DESIRED_STATUS_BY_ACTION: Partial<
  Record<AdActionType, 'ACTIVE' | 'PAUSED' | 'ARCHIVED'>
> = {
  PAUSE_AD: 'PAUSED',
  ENABLE_AD: 'ACTIVE',
  ARCHIVE_AD: 'ARCHIVED',
};

export type GuardEvaluation = WriteGuardVerdict & {
  /** O veredito comercial, exposto para o relatório de dry-run declará-lo. */
  planEntitlement: PlanEntitlementState;
  availability: ActionAvailability;
  dailyCap: { limit: number | null; usedToday: number };
  rateLimit: { limit: number; usedInWindow: number; windowSeconds: number };
  scopeWarning: string | null;
  reversible: boolean;
  desiredStatus: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | null;
};

/**
 * **Reunir os fatos que P5 julga.**
 *
 * Separado do use case porque são trabalhos diferentes: aqui se lê banco,
 * capability e configuração; lá se decide o que fazer com o veredito. Juntos,
 * passavam do teto de ~150 linhas que §16.6 impõe aos use cases — e o teto
 * existe justamente para que o caminho de escrita continue legível na hora em
 * que alguém precisar auditá-lo depois de um incidente.
 *
 * A decisão em si continua onde deve estar: `evaluateWriteGuards`, pura, no
 * domínio.
 */
@Injectable()
export class ActionGuardEvaluatorService {
  constructor(
    private readonly targets: ActionTargetsRepositoryInterface,
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly consents: WriteConsentRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly settings: ActionWriteSettingsReader,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly env: EnvService,
  ) {}

  async evaluate(input: {
    organizationId: string;
    target: ConnectedActionTarget;
    actionType: AdActionType;
    level: ActionLevel;
    targetEntityId: string;
  }): Promise<GuardEvaluation> {
    const { target } = input;

    const capability = this.registry
      .capabilitiesFor(target.platform)
      .find((entry) => entry.type === input.actionType);

    const [availability, consent, dailyCap, rateLimit, planEntitlement] =
      await Promise.all([
        this.availabilityOf({ ...input, capability }),
        this.consents.stateFor({
          organizationId: input.organizationId,
          integrationId: target.integrationId,
        }),
        this.dailyCapFor(input.organizationId),
        this.rateLimitFor(input.organizationId),
        this.planEntitlement.stateFor({
          organizationId: input.organizationId,
          feature: featureFor(input.actionType),
        }),
      ]);

    const verdict = evaluateWriteGuards({
      installationEnabled: this.env.get('PLATFORM_ACTIONS_ENABLED'),
      planEntitlement,
      organizationActionsEnabled: target.actionsEnabled,
      consent,
      actionType: input.actionType,
      availability,
      dailyCap,
      rateLimit,
    });

    return {
      ...verdict,
      planEntitlement,
      availability,
      dailyCap,
      rateLimit,
      scopeWarning: availability.scopeWarning ?? null,
      reversible: capability?.reversible ?? false,
      desiredStatus: DESIRED_STATUS_BY_ACTION[input.actionType] ?? null,
    };
  }

  private async availabilityOf(input: {
    organizationId: string;
    target: ConnectedActionTarget;
    level: ActionLevel;
    targetEntityId: string;
    capability:
      | ReturnType<ActionCapabilityRegistryService['capabilitiesFor']>[number]
      | undefined;
  }): Promise<ActionAvailability> {
    if (!input.capability) {
      /**
       * Plataforma sem gateway de escrita — Google e TikTok até A2-S8. Não é
       * erro de configuração, é uma resposta: a ação não existe **aqui**, e o
       * motivo precisa dizer isso em vez de estourar.
       */
      return {
        available: false,
        reason: 'UNSUPPORTED_BY_PLATFORM',
        detail: `A escrita em ${input.target.platform} ainda não está disponível.`,
      };
    }

    const inFlight = await this.targets.findInFlightWrites({
      organizationId: input.organizationId,
      targets: [{ type: input.level, id: input.targetEntityId }],
    });

    return resolveAvailability({
      capability: input.capability,
      level: input.level,
      observedStatus: input.target.observedStatus,
      syncState: input.target.syncState,
      inFlightExecutionId: inFlight.at(0)?.executionId ?? null,
      irreversibleStatuses: platformProfile(input.target.platform).status
        .irreversible,
      format: input.target.creativeFormat,
      unitKind: input.target.unitKind,
      unitLabel: unitLabelOf(input.target.platform, input.target.unitKind),
    });
  }

  /**
   * A janela deslizante de um minuto.
   *
   * Contada sobre `createdAt` e não sobre `startedAt`: o que se quer limitar é
   * a taxa com que pedidos **entram**, e uma execução ainda em fila já consumiu
   * a intenção de escrever.
   */
  private async rateLimitFor(organizationId: string) {
    const windowSeconds = 60;
    const limit = this.env.get('PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE');

    return {
      limit,
      windowSeconds,
      usedInWindow: await this.executions.countExecutionsSince({
        organizationId,
        since: new Date(Date.now() - windowSeconds * 1000),
      }),
    };
  }

  private async dailyCapFor(organizationId: string) {
    const limit = await this.settings.actionDailyCap(organizationId);

    if (limit === null) return { limit: null, usedToday: 0 };

    /**
     * Meia-noite **UTC**, não do fuso da conta. O teto é proteção de blast
     * radius, não relatório: uma organização com contas em três fusos teria três
     * meias-noites, e a janela do teto passaria a depender de qual conta a ação
     * toca.
     */
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    return {
      limit,
      usedToday: await this.executions.countExecutionsSince({
        organizationId,
        since,
      }),
    };
  }
}
