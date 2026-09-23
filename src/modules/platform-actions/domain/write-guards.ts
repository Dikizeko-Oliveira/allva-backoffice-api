import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import type { ActionAvailability } from 'src/modules/platform-actions/domain/availability';
import type { PlanEntitlementState } from 'src/modules/plans/domain/plan-entitlements';
import type { DomainErrorCategory } from 'src/shared/domain/error-category';

export type { PlanEntitlementState };

/**
 * §13.5 / P5 — **as guardas que toda escrita atravessa, em ordem declarada.**
 *
 * O gate de saída do sprint é *"nenhuma ação executa sem RBAC ok, kill switch
 * off, consentimento registrado, revalidação e audit gravado"* — e um teste por
 * caminho só é escrevível se os caminhos forem **um**. Espalhar as checagens
 * pelo use case as tornaria testáveis só de ponta a ponta, com banco e HTTP, e
 * é assim que a quinta guarda deixa de ser verificada sem ninguém notar.
 *
 * Puro de propósito: recebe fatos, devolve veredito. Quem lê banco, quem chama
 * plataforma e quem grava auditoria é o use case.
 */

export type WriteGuardFailure = {
  code: string;
  category: DomainErrorCategory;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type WriteGuardVerdict =
  | { allowed: true }
  | { allowed: false; failure: WriteGuardFailure };

export type WriteGuardInput = {
  /** `PLATFORM_ACTIONS_ENABLED` — a instalação escreve? */
  installationEnabled: boolean;
  /** O plano da organização inclui esta ação? Ver `PlanEntitlementService`. */
  planEntitlement: PlanEntitlementState;
  /** `Organization.actionsEnabled` — o kill switch de §13.5. */
  organizationActionsEnabled: boolean;
  consent: ConsentState;
  actionType: AdActionType;
  /** O veredito de §13.3 sobre este alvo, agora. */
  availability: ActionAvailability;
  dailyCap: { limit: number | null; usedToday: number };
  /**
   * C10 — o **rajada** por organização, distinto do teto diário.
   *
   * Os dois medem coisas diferentes: o teto limita quanto uma organização move
   * num dia, e este limita a que velocidade. Um script em laço que pause
   * quinhentos anúncios em dez segundos fica abaixo de um teto diário de mil e
   * ainda assim é o incidente que R1 descreve — quando alguém percebe, já
   * aconteceu.
   */
  rateLimit: { limit: number; usedInWindow: number; windowSeconds: number };
};

export type ConsentState =
  | { status: 'ABSENT' }
  | { status: 'REVOKED'; revokedAt: Date }
  | { status: 'GRANTED'; consentedActionTypes: AdActionType[] };

/**
 * A ordem não é estética — é a mensagem que o usuário recebe.
 *
 * Kill switch antes de consentimento porque uma organização que desligou a
 * escrita não precisa ouvir "conceda consentimento": ela já decidiu, e a
 * pergunta seguinte seria ruído. Consentimento antes de disponibilidade porque
 * "você não nos autorizou a escrever nesta integração" é uma condição da
 * relação, e "este anúncio já está pausado" é uma condição do momento —
 * responder a segunda primeiro faria o usuário resolver o anúncio para então
 * descobrir a autorização faltando. Teto por último porque é o único que muda
 * sozinho com o tempo.
 */
export function evaluateWriteGuards(input: WriteGuardInput): WriteGuardVerdict {
  if (!input.installationEnabled) {
    return deny({
      code: 'PLATFORM_ACTIONS_DISABLED',
      category: 'KILL_SWITCH',
      message: 'A escrita em plataforma está desligada nesta instalação.',
      remediation:
        'Fale com o suporte: a liberação é por instalação, não por organização.',
    });
  }

  /**
   * O plano vem **antes** do kill switch, e pela lógica que ordena o resto desta
   * função: quem não comprou a ação não precisa ouvir "religue as ações" nem
   * "conceda consentimento" — nenhuma das duas destrava nada para ele. É também
   * a mais permanente das guardas: não muda com o tempo como o teto, nem com o
   * estado do anúncio como a disponibilidade, nem com um botão que a própria
   * organização controla hoje.
   */
  if (!input.planEntitlement.allowed) {
    const { planLabel, featureLabel, upgradeTo, quota } = input.planEntitlement;

    return deny({
      code: 'PLAN_FEATURE_NOT_INCLUDED',
      category: 'PLAN_LIMITED',
      message: `O plano ${planLabel} não inclui ${featureLabel.toLowerCase()}.`,
      remediation: upgradeTo
        ? `Contrate o plano ${upgradeTo} para liberar.`
        : 'Fale com o time comercial para liberar.',
      details: { feature: featureLabel, planLabel, upgradeTo, quota },
    });
  }

  if (!input.organizationActionsEnabled) {
    return deny({
      code: 'ORGANIZATION_ACTIONS_DISABLED',
      category: 'KILL_SWITCH',
      message: 'Esta organização está com as ações em plataforma desligadas.',
      remediation:
        'Um administrador pode religar as ações nas configurações da organização.',
    });
  }

  const consentFailure = checkConsent(input.consent, input.actionType);
  if (consentFailure) return { allowed: false, failure: consentFailure };

  if (!input.availability.available) {
    return deny(availabilityFailure(input.availability));
  }

  /**
   * A rajada antes do teto diário: ela é a que protege contra o laço acidental,
   * e é a que o usuário resolve esperando trinta segundos. Reportar o teto
   * diário primeiro mandaria alguém esperar até amanhã por um bloqueio que
   * passa em meio minuto.
   */
  if (input.rateLimit.usedInWindow >= input.rateLimit.limit) {
    return deny({
      code: 'ACTION_RATE_LIMIT_EXCEEDED',
      category: 'RATE_LIMITED',
      message: `Esta organização já executou ${input.rateLimit.usedInWindow} ações nos últimos ${input.rateLimit.windowSeconds}s, e o limite é ${input.rateLimit.limit}.`,
      remediation: `Aguarde ${input.rateLimit.windowSeconds}s e tente de novo.`,
      details: {
        limit: input.rateLimit.limit,
        usedInWindow: input.rateLimit.usedInWindow,
        windowSeconds: input.rateLimit.windowSeconds,
      },
    });
  }

  /**
   * `limit: null` é ausência de teto, não teto zero. Colapsar os dois faria
   * toda organização que nunca configurou o limite parar de escrever — e o
   * sintoma seria "o produto não funciona", não "o teto foi atingido".
   */
  if (input.dailyCap.limit !== null) {
    if (input.dailyCap.usedToday >= input.dailyCap.limit) {
      return deny({
        code: 'ACTION_DAILY_CAP_REACHED',
        category: 'RATE_LIMITED',
        message: `Esta organização já executou ${input.dailyCap.usedToday} ações hoje, e o teto é ${input.dailyCap.limit}.`,
        remediation:
          'O teto reinicia à meia-noite UTC, ou um administrador pode aumentá-lo.',
        details: {
          limit: input.dailyCap.limit,
          usedToday: input.dailyCap.usedToday,
        },
      });
    }
  }

  return { allowed: true };
}

/**
 * O consentimento é **por integração e por tipo** (§13.5).
 *
 * Autorizar a Allva a pausar anúncios não é autorizá-la a mexer em orçamento, e
 * tratar os dois como o mesmo "sim" transformaria um consentimento estreito num
 * cheque em branco. Um tipo fora da lista é ausência de consentimento para
 * aquele tipo — não uma variação de "já consentiu".
 */
function checkConsent(
  consent: ConsentState,
  actionType: AdActionType,
): WriteGuardFailure | null {
  if (consent.status === 'ABSENT') {
    return {
      code: 'WRITE_CONSENT_REQUIRED',
      category: 'CONSENT_REQUIRED',
      message:
        'Esta integração ainda não autorizou a Allva a escrever na plataforma.',
      remediation:
        'Um administrador precisa registrar o consentimento de escrita para esta integração.',
    };
  }

  if (consent.status === 'REVOKED') {
    return {
      code: 'WRITE_CONSENT_REVOKED',
      category: 'CONSENT_REQUIRED',
      message: 'O consentimento de escrita desta integração foi revogado.',
      remediation: 'Um administrador pode conceder o consentimento novamente.',
      details: { revokedAt: consent.revokedAt.toISOString() },
    };
  }

  if (!consent.consentedActionTypes.includes(actionType)) {
    return {
      code: 'ACTION_TYPE_NOT_CONSENTED',
      category: 'CONSENT_REQUIRED',
      message: `O consentimento desta integração não cobre ${actionType}.`,
      remediation:
        'Um administrador pode ampliar os tipos de ação consentidos para esta integração.',
      details: {
        actionType,
        consentedActionTypes: consent.consentedActionTypes,
      },
    };
  }

  return null;
}

/** O veredito de disponibilidade traduzido para o erro tipado de §7.0.4. */
function availabilityFailure(
  availability: ActionAvailability,
): WriteGuardFailure {
  const detail = availability.detail ?? 'A ação não está disponível agora.';

  switch (availability.reason) {
    case 'WRITE_IN_FLIGHT':
      return {
        code: 'WRITE_IN_FLIGHT',
        category: 'WRITE_IN_FLIGHT',
        message: detail,
        remediation:
          'Aguarde a escrita em andamento terminar — ela tem prazo de 15 minutos.',
      };
    case 'UNSUPPORTED_BY_PLATFORM':
      return {
        code: 'ACTION_UNSUPPORTED',
        category: 'UNSUPPORTED_BY_PLATFORM',
        message: detail,
      };
    case 'TERMINAL_STATE':
      return {
        code: 'TARGET_IN_TERMINAL_STATE',
        category: 'UNSUPPORTED_BY_PLATFORM',
        message: detail,
      };
    case 'SYNC_UNRELIABLE':
      return {
        code: 'TARGET_OBSERVATION_STALE',
        category: 'INTEGRATION_UNREACHABLE',
        message: detail,
        remediation:
          'Sincronize a conta antes de escrever — agir sobre leitura vencida é agir no escuro.',
      };
    case 'ALREADY_IN_TARGET_STATE':
    default:
      return {
        code: 'TARGET_ALREADY_IN_STATE',
        category: 'PRECONDITION_FAILED',
        message: detail,
      };
  }
}

function deny(failure: WriteGuardFailure): WriteGuardVerdict {
  return { allowed: false, failure };
}
