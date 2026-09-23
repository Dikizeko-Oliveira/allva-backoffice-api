import type { ActiveSuppression } from '../suppression';
import type {
  PolicyThresholds,
  RecommendationSignals,
} from '../recommendation-plan';

/**
 * O que a geração precisa **antes** de planejar (§9.4 passos 1 e 2).
 *
 * Um contrato só, como em `ad-scoring` e `waste`: injetar os repositórios de
 * `ads`, `waste` e `ad-scoring` separadamente faria o motor depender do formato
 * interno de três módulos e quebrar a cada mudança que não é sobre recomendação.
 */

export type GenerationSettings = {
  organizationId: string;
  accountId: string;
  baseCurrency: string;
  windowDays: number;
  engineVersion: string;
  thresholds: PolicyThresholds;
  /**
   * §9.4 passo 1 — organização com sync válido e **sem recomputo de moeda**.
   *
   * Gerar durante o recomputo produziria um plano cujo valor estimado está numa
   * unidade e a metade da base, em outra.
   */
  generationAllowed: boolean;
  blockedReason: string | null;
};

/** Contagens que viram `scopeWarning` (§9.2) — quantos a ação afeta. */
export type ScopeCounts = {
  adsByAdSetId: Map<string, number>;
  adsByCampaignId: Map<string, number>;
};

export abstract class RecommendationTargetsRepositoryInterface {
  abstract settingsForOrganization(
    organizationId: string,
  ): Promise<GenerationSettings | null>;

  /**
   * §9.4 passo 2 — ads com waste/oportunidade aberto **ou** score fora de faixa.
   *
   * O "ou" importa: `REPLACE_CTA` não nasce de achado nenhum, e um motor que só
   * olhasse a lista de desperdício nunca o produziria.
   */
  abstract loadSignals(input: {
    organizationId: string;
    baseCurrency: string;
    thresholds: PolicyThresholds;
    now: Date;
  }): Promise<RecommendationSignals[]>;

  abstract scopeCounts(organizationId: string): Promise<ScopeCounts>;

  abstract activeSuppressions(
    organizationId: string,
  ): Promise<ActiveSuppression[]>;

  /** As organizações que a geração percorre: ao menos uma conta que o sync lê. */
  abstract listOrganizationsToGenerate(): Promise<string[]>;

  /**
   * As organizações que o ciclo de vida e a medição percorrem: qualquer conta,
   * vinculada ou não.
   *
   * Os dois não leem a plataforma e cuidam do que já está na tela — expirar a
   * recomendação vencida, medir o que foi aplicado. Pará-los quando a integração
   * cai deixaria a tela oferecendo, como atual, uma decisão sobre dado que parou
   * de chegar.
   */
  abstract listOrganizationsWithAdAccounts(): Promise<string[]>;
}
