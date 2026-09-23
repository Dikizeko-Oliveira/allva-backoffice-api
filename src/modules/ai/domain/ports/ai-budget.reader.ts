import type { PricingContext } from 'src/modules/ai/domain/model-pricing';

/**
 * O teto diário de LLM por organização (C9) — **um lugar, dois consumidores**.
 *
 * Nasceu como `aiBudgetFor` em `AdScoringTargetsRepositoryInterface`, junto do
 * primeiro consumidor. Com a análise criativa virando o segundo em A2-S9, a
 * pergunta "quanto esta organização ainda pode gastar com LLM hoje?" passou a
 * ser feita de dois lugares — e ela não é sobre score nem sobre criativo. É
 * sobre a organização.
 *
 * Deixá-la no port de scoring obrigaria `creative-lab` a importar o módulo de
 * score para saber o próprio orçamento, ou a reimplementar a leitura. A segunda
 * é pior: dois cálculos do mesmo teto divergem, e o que erra é sempre o que
 * ninguém revisita.
 */
export type AiBudgetSettings = {
  /** `OrganizationAdsSettings.llmDailyBudgetBase`, em moeda-base. */
  llmDailyBudgetBase: number | null;
  /**
   * Custo estimado de uma chamada, usado **antes** de ela acontecer.
   *
   * Somar só depois deixaria a última chamada sempre passar — e num lote de mil
   * anúncios isso é mil estouros de uma chamada cada.
   */
  estimatedCallCostBase: number | null;
  /**
   * O que é preciso saber para transformar preço de tabela em moeda-base.
   *
   * Viaja com o orçamento porque é a mesma pergunta — "quanto esta organização
   * pode gastar, e em que moeda isso é contado?" — e porque a moeda-base é dela,
   * não do processo: `Organization.baseCurrency` é por organização e mutável,
   * com máquina de estado própria para a troca.
   */
  pricing: PricingContext;
};

export abstract class AiBudgetReader {
  abstract budgetFor(organizationId: string): Promise<AiBudgetSettings>;
}
