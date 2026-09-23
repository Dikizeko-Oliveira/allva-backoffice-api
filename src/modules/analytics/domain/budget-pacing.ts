/**
 * Ritmo de consumo de orçamento (N1) — **função pura**.
 *
 * A pergunta: *no ritmo atual, o orçamento do período acaba antes ou sobra?*
 *
 * Três decisões de modelagem que não são detalhe:
 *
 * 1. **O orçamento de uma campanha é o dela, ou a soma dos conjuntos — nunca
 *    os dois.** Com CBO o orçamento vive na campanha e os conjuntos vêm `null`;
 *    sem CBO é o contrário. Somar os dois níveis dobraria o teto de toda conta
 *    que usa CBO, e o número de capa passaria a dizer que sobra orçamento
 *    exatamente onde ele está estourando.
 * 2. **Só orçamento diário entra.** `lifetimeBudget` é um teto de vôo inteiro,
 *    não um ritmo: convertê-lo em "por dia" exige as datas de início e fim, e
 *    campanha sem `endedAt` não tem denominador. Elas são contadas e declaradas.
 * 3. **Não há projeção, e a ausência é deliberada.** A janela é móvel (últimos
 *    N dias), então não existem dias futuros a projetar: `burnRate × período`
 *    devolveria o próprio gasto com outro nome. Projeção só passa a significar
 *    algo quando a janela virar ciclo de orçamento com data de virada — e o
 *    ciclo não é sincronizado de nenhuma plataforma hoje.
 */

export type PacingStatus = 'OVERSPENDING' | 'HEALTHY' | 'UNDERSPENDING';

/**
 * A faixa de tolerância antes de chamar o ritmo de errado.
 *
 * ±10% existe porque gasto diário oscila por leilão, e um alerta que dispara
 * com 2% de desvio é ruído que ensina o usuário a ignorar a tela.
 */
export const PACING_TOLERANCE = 0.1;

export type CampaignBudget = {
  campaignId: string;
  campaignName: string;
  platform: string;
  /** Diário, já na moeda-base. `null` quando não há orçamento diário resolvível. */
  dailyBudgetBase: number | null;
  /** Gasto do período, na moeda-base. */
  spendBase: number;
};

export type PacingRow = {
  campaignId: string;
  campaignName: string;
  platform: string;
  dailyBudgetBase: number;
  spendBase: number;
  /** O que **deveria** ter sido gasto até aqui, no ritmo do orçamento. */
  expectedSpendBase: number;
  burnRateBase: number;
  status: PacingStatus;
};

export type PacingSummary = {
  /** Soma dos orçamentos diários resolvíveis × dias do período. */
  budgetBase: number;
  spendBase: number;
  expectedSpendBase: number;
  /** Média diária observada no período decorrido. */
  burnRateBase: number;
  status: PacingStatus;
  rows: PacingRow[];
  /** Gasto por dia, contra o teto diário — mostra em que dia o ritmo estourou. */
  timeseries: PacingPoint[];
  /** Campanhas sem orçamento diário resolvível (vôo, ou nenhum declarado). */
  excludedWithoutDailyBudget: number;
};

/** Um dia da série: o que saiu, e o que o orçamento permitia naquele dia. */
export type PacingPoint = {
  date: string;
  spendBase: number;
  /** O teto diário somado das campanhas com orçamento resolvível. */
  allowedBase: number;
};

/**
 * O veredito de ritmo, comparando o gasto com o que a régua do orçamento
 * previa **para os dias já decorridos** — não para o período inteiro.
 *
 * Comparar gasto de 5 dias com orçamento de 30 diria que toda conta está
 * economizando, sempre.
 */
export function statusOf(
  spendBase: number,
  expectedSpendBase: number,
): PacingStatus {
  if (expectedSpendBase <= 0) return 'HEALTHY';

  const ratio = spendBase / expectedSpendBase;

  if (ratio > 1 + PACING_TOLERANCE) return 'OVERSPENDING';
  if (ratio < 1 - PACING_TOLERANCE) return 'UNDERSPENDING';
  return 'HEALTHY';
}

export function computePacing(input: {
  campaigns: CampaignBudget[];
  /** Dias já decorridos no período — o denominador do ritmo observado. */
  elapsedDays: number;
  /** Dias do período inteiro. */
  periodDays: number;
  /** Gasto diário da organização, já em moeda-base. */
  dailySpend: Array<{ date: string; spendBase: number }>;
}): PacingSummary {
  const withBudget = input.campaigns.filter(
    (campaign): campaign is CampaignBudget & { dailyBudgetBase: number } =>
      campaign.dailyBudgetBase !== null && campaign.dailyBudgetBase > 0,
  );

  // Sem dia decorrido não há ritmo a apurar: devolver zero diria "gastou nada",
  // que é diferente de "ainda não há de onde tirar a média".
  const elapsed = Math.max(input.elapsedDays, 0);

  const rows: PacingRow[] = withBudget.map((campaign) => {
    const expectedSpendBase = campaign.dailyBudgetBase * elapsed;

    return {
      campaignId: campaign.campaignId,
      campaignName: campaign.campaignName,
      platform: campaign.platform,
      dailyBudgetBase: campaign.dailyBudgetBase,
      spendBase: campaign.spendBase,
      expectedSpendBase,
      burnRateBase: elapsed > 0 ? campaign.spendBase / elapsed : 0,
      status: statusOf(campaign.spendBase, expectedSpendBase),
    };
  });

  const dailyBudgetTotal = withBudget.reduce(
    (sum, campaign) => sum + campaign.dailyBudgetBase,
    0,
  );
  const spendBase = rows.reduce((sum, row) => sum + row.spendBase, 0);
  const expectedSpendBase = dailyBudgetTotal * elapsed;
  const burnRateBase = elapsed > 0 ? spendBase / elapsed : 0;

  return {
    budgetBase: dailyBudgetTotal * input.periodDays,
    spendBase,
    expectedSpendBase,
    burnRateBase,
    status: statusOf(spendBase, expectedSpendBase),
    rows: rows.sort((a, b) => b.spendBase - a.spendBase),
    timeseries: input.dailySpend.map((day) => ({
      date: day.date,
      spendBase: day.spendBase,
      allowedBase: dailyBudgetTotal,
    })),
    excludedWithoutDailyBudget: input.campaigns.length - withBudget.length,
  };
}

/**
 * Resolve o orçamento diário de uma campanha: o dela, **ou** a soma dos
 * conjuntos — nunca os dois (CBO).
 */
export function resolveDailyBudget(input: {
  campaignDailyBudget: number | null;
  adSetDailyBudgets: Array<number | null>;
}): number | null {
  if (input.campaignDailyBudget !== null && input.campaignDailyBudget > 0) {
    return input.campaignDailyBudget;
  }

  const fromAdSets = input.adSetDailyBudgets.filter(
    (value): value is number => value !== null && value > 0,
  );

  if (fromAdSets.length === 0) return null;

  return fromAdSets.reduce((sum, value) => sum + value, 0);
}
