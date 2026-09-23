import type { DataMaturity } from 'src/shared/domain/provenance';
import type { RecommendationStatus } from './contracts/recommendation-catalog';

/**
 * Revalidação de premissa (§9.5 passo 1) — **antes de qualquer escrita**.
 *
 * > A recomendação é gerada num lote diário e aplicada quando o usuário clica,
 * > dias depois. No intervalo, conversões são re-declaradas retroativamente, o
 * > anúncio pode ter sido pausado na plataforma, o token pode ter expirado. Sem
 * > revalidação, o clique executa uma decisão tomada sobre um mundo que já não
 * > existe — e registra o resultado como acerto no dataset de P8.
 *
 * É o que separa um copiloto de um gerador de acidentes. As seis verificações
 * são puras: recebem o estado observado, devolvem veredito. Quem lê o estado é a
 * aplicação; quem decide é isto.
 */

export type PremiseCheckName =
  | 'RECOMMENDATION_STATE'
  | 'WASTE_ITEMS_OPEN'
  | 'EVIDENCE_FRESH'
  | 'AD_ACTIONABLE'
  | 'CAPABILITY_AND_CONSENT'
  | 'NO_WRITE_IN_FLIGHT';

export type PremiseState = {
  status: RecommendationStatus;
  expiresAt: Date | null;
  suppressed: boolean;

  /** Quantos dos achados vinculados continuam abertos. */
  linkedWasteItems: number;
  openWasteItems: number;

  evidenceAsOf: Date;
  /** Prazo além do qual a evidência deixa de sustentar o veredito. */
  evidenceMaxAgeDays: number;
  /** A maturidade **agora**: o que era `MATURE` continua sendo. */
  dataMaturity: DataMaturity | null;
  requiresMature: boolean;

  adArchived: boolean;
  adObservable: boolean;
  integrationReachable: boolean;

  capabilitySupported: boolean;
  consentGranted: boolean;
  killSwitchOn: boolean;

  /** I2 generalizada: escrita em voo **no anúncio ou no alvo da ação**. */
  writeInFlightId: string | null;
};

export type PremiseFailure = {
  check: PremiseCheckName;
  code: string;
  reason: string;
  /** A recomendação expira **na hora** quando a premissa venceu de vez. */
  expiresRecommendation: boolean;
};

export type PremiseVerdict =
  | { valid: true; failure: null }
  | { valid: false; failure: PremiseFailure };

const VALID: PremiseVerdict = { valid: true, failure: null };

const APPLICABLE_STATUSES: RecommendationStatus[] = ['NEW', 'ACKNOWLEDGED'];

/**
 * As seis verificações, na ordem de §9.5.
 *
 * A ordem é a do custo crescente de descobrir: estado e vínculos são leitura
 * local; alcance da integração e escrita em voo custam mais. Falhar cedo poupa
 * chamada — e, no caso da escrita em voo, evita competir por uma entidade que
 * outro processo já está mudando.
 */
export function revalidate(state: PremiseState): PremiseVerdict {
  if (!APPLICABLE_STATUSES.includes(state.status)) {
    return fail(
      'RECOMMENDATION_STATE',
      'RECOMMENDATION_NOT_APPLICABLE',
      `A recomendação está em ${state.status} e só pode ser aplicada em NEW ou ACKNOWLEDGED.`,
      false,
    );
  }

  if (state.suppressed) {
    return fail(
      'RECOMMENDATION_STATE',
      'RECOMMENDATION_SUPPRESSED',
      'Existe uma supressão ativa para este tipo de recomendação neste escopo.',
      true,
    );
  }

  if (state.expiresAt && state.expiresAt <= new Date()) {
    return fail(
      'RECOMMENDATION_STATE',
      'RECOMMENDATION_EXPIRED',
      'A recomendação venceu antes de ser aplicada.',
      true,
    );
  }

  // Todos os achados de origem resolvidos: o problema acabou por outro caminho,
  // e aplicar agora agiria sobre um anúncio que já foi corrigido.
  if (state.linkedWasteItems > 0 && state.openWasteItems === 0) {
    return fail(
      'WASTE_ITEMS_OPEN',
      'RECOMMENDATION_PREMISE_RESOLVED',
      'Todos os achados que originaram esta recomendação já foram resolvidos.',
      true,
    );
  }

  if (ageInDays(state.evidenceAsOf) > state.evidenceMaxAgeDays) {
    return fail(
      'EVIDENCE_FRESH',
      'RECOMMENDATION_PREMISE_STALE',
      `A evidência é de ${ageInDays(state.evidenceAsOf)} dias e o limite é ${state.evidenceMaxAgeDays}.`,
      true,
    );
  }

  // §8.9: o que era `MATURE` continua sendo, mas a janela pode ter mudado de
  // conta — atribuição reconfigurada na plataforma reclassifica os dias.
  if (state.requiresMature && state.dataMaturity !== 'MATURE') {
    return fail(
      'EVIDENCE_FRESH',
      'RECOMMENDATION_PREMISE_STALE',
      `A janela deixou de ser MATURE (${state.dataMaturity ?? 'sem observação'}) e não sustenta mais o veredito.`,
      true,
    );
  }

  if (state.adArchived || !state.adObservable) {
    return fail(
      'AD_ACTIONABLE',
      'AD_NOT_ACTIONABLE',
      'O anúncio foi arquivado ou deixou de ser observável na plataforma.',
      true,
    );
  }

  if (!state.integrationReachable) {
    return fail(
      'AD_ACTIONABLE',
      'INTEGRATION_UNREACHABLE',
      'A integração desta conta não está alcançável agora.',
      // Não expira: a integração volta, e o diagnóstico continua verdadeiro.
      false,
    );
  }

  if (!state.capabilitySupported) {
    return fail(
      'CAPABILITY_AND_CONSENT',
      'ACTION_UNSUPPORTED',
      'A plataforma não suporta a ação prevista para este anúncio.',
      true,
    );
  }

  if (state.killSwitchOn) {
    return fail(
      'CAPABILITY_AND_CONSENT',
      'PLATFORM_ACTIONS_DISABLED',
      'As ações em plataforma estão desligadas para esta organização.',
      false,
    );
  }

  if (!state.consentGranted) {
    return fail(
      'CAPABILITY_AND_CONSENT',
      'WRITE_CONSENT_REQUIRED',
      'Não há consentimento de escrita registrado para esta integração.',
      false,
    );
  }

  if (state.writeInFlightId) {
    return fail(
      'NO_WRITE_IN_FLIGHT',
      'WRITE_IN_FLIGHT',
      `Já existe uma escrita em voo sobre o mesmo alvo (${state.writeInFlightId}).`,
      false,
    );
  }

  return VALID;
}

function fail(
  check: PremiseCheckName,
  code: string,
  reason: string,
  expiresRecommendation: boolean,
): PremiseVerdict {
  return {
    valid: false,
    failure: { check, code, reason, expiresRecommendation },
  };
}

function ageInDays(since: Date): number {
  return Math.floor((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
}
