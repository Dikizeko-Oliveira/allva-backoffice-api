import type { AdSyncState } from 'src/modules/ads/domain/ad-sync-state';
import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';
import type {
  ActionLevel,
  AdStatus,
} from 'src/modules/ads/domain/platform/platform-profile';
import {
  formatScopeRefusal,
  inFormatScope,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type { AdActionCapability } from 'src/modules/platform-actions/domain/contracts/action-contracts';

/**
 * §13.3 — **por que uma ação não está disponível é parte da resposta.**
 *
 * A alternativa seria omitir da lista o que não dá para fazer. Ela produz uma
 * tela em que "pausar" some sem explicação, o usuário conclui que o produto
 * quebrou, e o suporte descobre três dias depois que o anúncio já estava
 * pausado. P6 diz o contrário: declarar, com motivo.
 */

export type UnavailableReason =
  /** A plataforma não faz isso. O motivo vem do gateway. */
  | 'UNSUPPORTED_BY_PLATFORM'
  /** O alvo já está no estado que a ação produziria. */
  | 'ALREADY_IN_TARGET_STATE'
  /** Estado terminal: não há volta declarada no `PlatformProfile`. */
  | 'TERMINAL_STATE'
  /** Há escrita em voo no mesmo alvo (I2). */
  | 'WRITE_IN_FLIGHT'
  /** A leitura do alvo não é confiável agora — escrever seria escrever no escuro. */
  | 'SYNC_UNRELIABLE'
  /**
   * O plano contratado não inclui a ação.
   *
   * Declarada como as outras, e não omitida da lista, pela mesma razão que
   * `UNSUPPORTED_BY_PLATFORM`: a tela precisa poder mostrar o que existe e não
   * está ao alcance. Sumir com a ação faria o usuário nunca descobrir o que
   * está deixando de comprar.
   */
  | 'PLAN_LIMITED';

export type ActionAvailability = {
  available: boolean;
  reason?: UnavailableReason;
  detail?: string;
  /**
   * §13.1 — ação em campanha é exceção justificada por restrição de plataforma,
   * nunca alvo padrão, e **sempre** com aviso de escopo.
   */
  scopeWarning?: string;
  /** O estado é irreversível: a UI avisa antes da confirmação, não depois. */
  irreversible?: boolean;
};

export type AvailabilityInput = {
  capability: AdActionCapability;
  level: ActionLevel;
  observedStatus: AdStatus;
  syncState: AdSyncState;
  /** Um id de execução em voo sobre o mesmo alvo, se houver. */
  inFlightExecutionId?: string | null;
  /** `PlatformProfile.status.irreversible`. */
  irreversibleStatuses: AdStatus[];
  /** O formato do criativo do anúncio, como o ingest gravou. */
  format: string | null;
  /** Anúncio ou pacote de recursos — ver `AdActionCapability.units`. */
  unitKind: AdUnitKind;
  /** Como a plataforma chama a unidade (`unitLabelOf`) — é o que a recusa diz. */
  unitLabel: string;
};

const DEFAULT_UNITS: readonly AdUnitKind[] = ['AD'];

/** O estado que cada ação de status produz, quando produz um. */
const RESULTING_STATUS: Partial<Record<string, AdStatus>> = {
  PAUSE_AD: 'PAUSED',
  PAUSE_AD_SET: 'PAUSED',
  PAUSE_CAMPAIGN: 'PAUSED',
  ENABLE_AD: 'ACTIVE',
  ENABLE_AD_SET: 'ACTIVE',
  ENABLE_CAMPAIGN: 'ACTIVE',
  ARCHIVE_AD: 'ARCHIVED',
};

export function resolveAvailability(
  input: AvailabilityInput,
): ActionAvailability {
  const { capability, observedStatus, syncState } = input;

  if (!capability.supported) {
    return {
      available: false,
      reason: 'UNSUPPORTED_BY_PLATFORM',
      detail:
        capability.unsupportedReason ?? 'A plataforma não oferece esta ação.',
    };
  }

  /**
   * A ação precisa ter sido declarada para esta unidade — **em todos os
   * níveis**. Pausar a campanha de um grupo de recursos do Google é pausar uma
   * campanha comum, e o gateway declara; a campanha de um anúncio Smart+ do
   * TikTok tem rota própria, e a ação padrão escreveria no lugar errado. Quem
   * sabe a diferença é o gateway, não esta função.
   */
  if (!(capability.units ?? DEFAULT_UNITS).includes(input.unitKind)) {
    return {
      available: false,
      reason: 'UNSUPPORTED_BY_PLATFORM',
      detail: `Esta ação ainda não está disponível para ${input.unitLabel}.`,
    };
  }

  /**
   * A plataforma faz a ação, **mas não neste formato** — é o mesmo motivo, dito
   * sobre o anúncio. Vem antes do estado: trocar CTA num anúncio de busca não
   * passa a existir quando ele sai da revisão.
   */
  if (capability.formats && !inFormatScope(capability.formats, input.format)) {
    return {
      available: false,
      reason: 'UNSUPPORTED_BY_PLATFORM',
      detail: formatScopeRefusal(capability.formats, input.format),
    };
  }

  /**
   * **Estado terminal barra antes de tudo o mais.** Um anúncio `DELETED` não
   * volta, e oferecer "reativar" sobre ele é oferecer um botão que só pode
   * falhar — depois de o usuário ter decidido que ia funcionar.
   */
  if (input.irreversibleStatuses.includes(observedStatus)) {
    return {
      available: false,
      reason: 'TERMINAL_STATE',
      detail: `O alvo está em ${observedStatus}, que a plataforma declara irreversível.`,
    };
  }

  /**
   * I2 antes da coerência de estado: com escrita em voo, o estado observado é
   * justamente o que está prestes a mudar, e julgá-lo agora julga um mundo com
   * data de validade.
   */
  if (input.inFlightExecutionId) {
    return {
      available: false,
      reason: 'WRITE_IN_FLIGHT',
      detail: `Há uma escrita em andamento neste alvo (${input.inFlightExecutionId}).`,
    };
  }

  /**
   * `PENDING_WRITE` é I2 vista pelo anúncio; `UNREACHABLE` e `STALE` são a
   * leitura não valendo. Escrever sobre observação que não vale é decidir com
   * base num estado que pode não ser o atual — e o produto inteiro existe para
   * não fazer isso.
   */
  if (syncState === 'UNREACHABLE' || syncState === 'STALE') {
    return {
      available: false,
      reason: 'SYNC_UNRELIABLE',
      detail:
        syncState === 'UNREACHABLE'
          ? 'A plataforma não está respondendo por esta conta.'
          : 'A última leitura deste anúncio está vencida.',
    };
  }

  const resulting = RESULTING_STATUS[capability.type];

  if (resulting && resulting === observedStatus) {
    return {
      available: false,
      reason: 'ALREADY_IN_TARGET_STATE',
      detail: `O alvo já está em ${observedStatus}.`,
    };
  }

  /**
   * A irreversibilidade vem da **capability**, não do estado resultante.
   * `ARCHIVE_AD` produz `ARCHIVED`, que não está em `irreversible` no perfil da
   * Meta — mas §13.1 declara a ação sem volta, e é a ação que o usuário
   * confirma. Ler a lista de estados aqui deixaria o aviso de fora exatamente
   * na ação que mais precisa dele.
   */
  return {
    available: true,
    ...(input.level === 'CAMPAIGN'
      ? {
          scopeWarning:
            'Esta ação incide sobre a campanha inteira, não apenas sobre este anúncio.',
        }
      : {}),
    ...(capability.reversible ? {} : { irreversible: true }),
  };
}
