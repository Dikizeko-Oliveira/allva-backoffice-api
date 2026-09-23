import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * O orçamento declarado de uma campanha, com o dos conjuntos ao lado.
 *
 * Os dois níveis vêm juntos **porque só um deles vale** (CBO): com orçamento na
 * campanha, os conjuntos vêm `null`; sem ele, o inverso. Quem resolve qual usar
 * é `resolveDailyBudget`, no domínio — trazer só um nível daqui obrigaria a
 * segunda consulta a descobrir que o escolhido estava vazio.
 *
 * `currency` é a da **conta** (R-M), nunca a moeda-base: a conversão acontece
 * depois, pelo módulo `currency`, que é o único dono de `fx_rates` (§16.10).
 */
export type CampaignBudgetRow = {
  campaignId: string;
  campaignName: string;
  platform: Platform;
  currency: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  adSetDailyBudgets: Array<number | null>;
};

export abstract class CampaignBudgetsRepositoryInterface {
  /** Campanhas não arquivadas da organização, com orçamento dos dois níveis. */
  abstract listActiveWithBudgets(query: {
    organizationId: string;
    platforms?: Platform[];
  }): Promise<CampaignBudgetRow[]>;

  /**
   * A moeda-base atual da organização — só o fallback de quando a janela não
   * tem gasto e, portanto, nenhuma linha de série de onde ler a unidade.
   */
  abstract organizationBaseCurrency(
    organizationId: string,
  ): Promise<string | null>;
}
