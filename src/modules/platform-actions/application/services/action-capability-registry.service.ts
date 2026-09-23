import { Injectable } from '@nestjs/common';
import type {
  ActionLevel,
  AdActionType,
} from 'src/modules/ads/domain/platform/platform-profile';
import {
  actionImpactFor,
  platformProfile,
  unitLabelOf,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type { ActionImpact } from 'src/modules/ads/domain/platform/mutation-strategy';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  ActionAvailability,
  resolveAvailability,
} from 'src/modules/platform-actions/domain/availability';
import type { AdActionCapability } from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { AdActionGateway } from 'src/modules/platform-actions/domain/ports/ad-action.gateway';
import type {
  ActionTargetView,
  InFlightWrite,
} from 'src/modules/platform-actions/domain/ports/action-targets.repository';

/** O nível em que cada tipo de ação incide. */
const LEVEL_OF: Record<AdActionType, ActionLevel> = {
  PAUSE_AD: 'AD',
  ENABLE_AD: 'AD',
  ARCHIVE_AD: 'AD',
  DUPLICATE_AD: 'AD',
  REPLACE_CREATIVE: 'AD',
  REPLACE_COPY: 'AD',
  REPLACE_CTA: 'AD',
  PAUSE_AD_SET: 'AD_SET',
  ENABLE_AD_SET: 'AD_SET',
  ADJUST_AD_SET_BUDGET: 'AD_SET',
  PAUSE_CAMPAIGN: 'CAMPAIGN',
  ENABLE_CAMPAIGN: 'CAMPAIGN',
  ADJUST_CAMPAIGN_BUDGET: 'CAMPAIGN',
};

export type AvailableAction = ActionAvailability & {
  type: AdActionType;
  level: ActionLevel;
  requiresRecreate: boolean;
  createsEntity: boolean;
  /**
   * §13.3 — **o que a ação faz com a entrega**, antes da confirmação.
   *
   * Separado de `requiresRecreate` de propósito: na Meta, trocar o criativo
   * mantém o `ad_id` e ainda assim reinicia o aprendizado e zera a prova
   * social. Enquanto os dois eram um booleano só, a tela tinha de escolher
   * entre avisar de menos e mentir sobre o id.
   */
  impact: ActionImpact;
  validationDepth: AdActionCapability['validationDepth'];
  constraints?: Record<string, unknown>;
  /** A permissão que o ator precisa ter — a tela não adivinha (§13.5). */
  requiredPermission: string;
};

/**
 * §13.3 — **o registro de capacidades.**
 *
 * Agrega o que cada gateway declara e cruza com o estado do alvo. É deliberado
 * que a resposta liste **todas** as treze ações, e não só as disponíveis: uma
 * lista curta obriga a tela a inventar o motivo da ausência, e o motivo
 * inventado sempre é "não disponível", que não ajuda ninguém.
 *
 * **Nenhuma decisão de plataforma acontece aqui** (P6). O registro pergunta ao
 * gateway; qual gateway responder é resolução por mapa, não por `if`.
 */
@Injectable()
export class ActionCapabilityRegistryService {
  private readonly byPlatform: Map<Platform, AdActionGateway>;

  constructor(gateways: AdActionGateway[]) {
    this.byPlatform = new Map(
      gateways.map((gateway) => [gateway.platform, gateway]),
    );
  }

  /** As plataformas que já sabem escrever. As demais respondem UNSUPPORTED. */
  supportedPlatforms(): Platform[] {
    return [...this.byPlatform.keys()];
  }

  capabilitiesFor(platform: Platform): AdActionCapability[] {
    return this.byPlatform.get(platform)?.capabilities() ?? [];
  }

  gatewayFor(platform: Platform): AdActionGateway | null {
    return this.byPlatform.get(platform) ?? null;
  }

  /**
   * O que é oferecível **neste anúncio, agora** — com motivo para o que não é.
   */
  resolveFor(input: {
    target: ActionTargetView;
    inFlight: InFlightWrite[];
    permissionFor: (type: AdActionType) => string;
  }): AvailableAction[] {
    const { target } = input;
    const profile = platformProfile(target.platform);
    const capabilities = this.capabilitiesFor(target.platform);

    if (capabilities.length === 0) {
      /**
       * Plataforma sem gateway de escrita não é um erro de configuração: é
       * Google e TikTok até A2-S8. Declarar as treze como indisponíveis com o
       * motivo certo é o que permite a mesma tela servir as três plataformas
       * sem saber quais já escrevem.
       */
      return ALL_ACTION_TYPES.map((type) => ({
        type,
        level: LEVEL_OF[type],
        available: false,
        reason: 'UNSUPPORTED_BY_PLATFORM' as const,
        detail: `A escrita em ${target.platform} ainda não está disponível.`,
        requiresRecreate: false,
        createsEntity: false,
        impact: actionImpactFor(target.platform, type),
        validationDepth: 'LOCAL_ONLY' as const,
        requiredPermission: input.permissionFor(type),
      }));
    }

    return capabilities.map((capability) => {
      const level = LEVEL_OF[capability.type];
      const targetId = this.targetIdFor(level, target);

      /**
       * Sem conjunto, uma ação de conjunto não tem alvo — é o caso do Google
       * Search, cuja hierarquia não tem o nível intermediário. Não é
       * indisponibilidade da plataforma: é ausência de alvo, e o motivo
       * declarado precisa dizer isso.
       */
      if (!targetId) {
        return {
          type: capability.type,
          level,
          available: false,
          reason: 'UNSUPPORTED_BY_PLATFORM' as const,
          detail: `Este anúncio não tem ${profile.hierarchy.adSetLabel} sobre o qual agir.`,
          requiresRecreate: capability.requiresRecreate,
          createsEntity: capability.createsEntity,
          impact: actionImpactFor(target.platform, capability.type),
          validationDepth: capability.validationDepth,
          requiredPermission: input.permissionFor(capability.type),
        };
      }

      const availability = resolveAvailability({
        capability,
        level,
        observedStatus: target.observedStatus,
        syncState: target.syncState,
        inFlightExecutionId:
          input.inFlight.find(
            (write) =>
              write.targetEntityType === level &&
              write.targetEntityId === targetId,
          )?.executionId ?? null,
        irreversibleStatuses: profile.status.irreversible,
        format: target.creativeFormat,
        unitKind: target.unitKind,
        unitLabel: unitLabelOf(target.platform, target.unitKind),
      });

      return {
        ...availability,
        type: capability.type,
        level,
        requiresRecreate: capability.requiresRecreate,
        createsEntity: capability.createsEntity,
        /**
         * Vem do `PlatformProfile`, não da capability: o impacto é fato da
         * plataforma, e o gateway responde sobre a chamada. Duplicá-lo nos dois
         * lugares os faria divergir, e o que erraria é o aviso.
         */
        impact: actionImpactFor(target.platform, capability.type),
        validationDepth: capability.validationDepth,
        ...(capability.constraints
          ? { constraints: capability.constraints }
          : {}),
        requiredPermission: input.permissionFor(capability.type),
      };
    });
  }

  /** O id **interno** do alvo — I2 e a persistência raciocinam por ele. */
  targetIdFor(level: ActionLevel, target: ActionTargetView): string | null {
    if (level === 'AD') return target.adId;
    if (level === 'AD_SET') return target.adSet?.id ?? null;
    return target.campaign.id;
  }

  /** O id **na plataforma** — só o gateway usa. */
  externalTargetIdFor(
    level: ActionLevel,
    target: ActionTargetView,
  ): string | null {
    if (level === 'AD') return target.externalAdId;
    if (level === 'AD_SET') return target.adSet?.externalId ?? null;
    return target.campaign.externalId;
  }

  levelOf(type: AdActionType): ActionLevel {
    return LEVEL_OF[type];
  }
}

const ALL_ACTION_TYPES = Object.keys(LEVEL_OF) as AdActionType[];
