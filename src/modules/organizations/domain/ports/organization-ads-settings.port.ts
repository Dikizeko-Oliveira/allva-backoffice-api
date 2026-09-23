/**
 * A **janela de análise** da organização — a régua com que a mídia dela é
 * medida.
 *
 * Vive em `organization_ads_settings` (D16/A10) e é lida hoje pelo scoring, pelo
 * detector de desperdício, pela Visão Geral e pelo construtor de relatórios.
 * Não é preferência de tela: mudá-la muda o que o produto inteiro considera
 * "recente", e o efeito aparece quando o ciclo de scoring seguinte reescreve as
 * colunas materializadas — não no instante da gravação.
 */
export type OrganizationAdsSettings = {
  organizationId: string;
  scoringWindowDays: number;
};

/**
 * O teto diário de gasto com IA, em moeda-base.
 *
 * `null` é **sem teto**, e `evaluateBudget` o lê literalmente: permite. Foi o
 * estado de toda organização até a coluna ganhar default, e a consequência é
 * que a narrativa noturna — o maior gasto de IA do produto, que sai para todo
 * score novo — rodava sem parede alguma.
 */
export const DEFAULT_LLM_DAILY_BUDGET_BASE = 50;

/**
 * Os limites da janela.
 *
 * O piso é 7 porque abaixo de uma semana a detecção passa a decidir sobre ruído
 * de fim de semana: um anúncio sem conversão na terça não é um anúncio sem
 * conversão. O teto é 90 pelo mesmo motivo que o filtro de período da Visão
 * Geral para ali - além disso a série deixa de descrever a campanha que está no
 * ar hoje.
 */
export const MIN_SCORING_WINDOW_DAYS = 7;
export const MAX_SCORING_WINDOW_DAYS = 90;

export abstract class OrganizationAdsSettingsPortInterface {
  abstract find(organizationId: string): Promise<OrganizationAdsSettings>;

  /** Grava e devolve como ficou. */
  abstract updateScoringWindowDays(
    organizationId: string,
    scoringWindowDays: number,
  ): Promise<OrganizationAdsSettings>;

  /** O teto diário de gasto com IA. Ver {@link OrganizationAdsSettings}. */
  abstract findLlmDailyBudget(organizationId: string): Promise<number | null>;

  /**
   * Grava o teto diário de IA e devolve como ficou.
   *
   * **Separado de `updateScoringWindowDays` de propósito.** As duas colunas
   * moram na mesma tabela e respondem a donos diferentes: a janela é do dono da
   * organização — ela diz o que a *própria* operação considera recente —, e o
   * teto de gasto é do operador, porque move dinheiro e contorna o plano. Um
   * método só, com dois campos opcionais, convidaria a expor os dois na mesma
   * rota e a entregar ao cliente a chave do próprio teto.
   *
   * `null` remove o teto, e é o que um contrato ainda não precificado precisa:
   * sem ele, a única forma de não cortar uma entrega negociada seria inventar
   * um número no lugar do comercial.
   */
  abstract updateLlmDailyBudget(
    organizationId: string,
    llmDailyBudgetBase: number | null,
  ): Promise<number | null>;
}
