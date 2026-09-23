import { ApiProperty } from '@nestjs/swagger';

/**
 * Analytics — os quatro agregados que sustentam a Visão Geral e Multicanais.
 *
 * **Soma o normalizado, nunca o original** (M1). Somar `spend` de contas em USD
 * e em BRL produz um número que não é dinheiro em moeda nenhuma — era o que a
 * v1 fazia, e a soma parecia certa porque ninguém declarava a unidade. Daí
 * `currency` e `excludedPendingNormalization` em todo total: o consumidor
 * precisa saber em que moeda o número está e quantas linhas não puderam entrar.
 */

export class AggregatedTotalsDto {
  @ApiProperty()
  spend!: number;

  @ApiProperty()
  revenue!: number;

  @ApiProperty()
  impressions!: number;

  @ApiProperty()
  clicks!: number;

  @ApiProperty()
  conversions!: number;

  @ApiProperty({ type: Number, nullable: true })
  ctr!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpc!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpa!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  roas!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'BRL',
    description:
      'Em que moeda os valores acima estão. Agregado sem moeda declarada é ' +
      'número sem significado quando a organização tem contas em moedas ' +
      'diferentes.',
  })
  currency!: string | null;

  @ApiProperty({
    description:
      'Linhas cuja taxa do dia ainda não existia na ingestão: entraram como ' +
      'zero na base, e o consumidor precisa saber (M1, P7).',
  })
  excludedPendingNormalization!: number;
}

/**
 * Variação percentual contra o período imediatamente anterior, de mesmo
 * tamanho.
 *
 * **`null` não é zero.** Vem `null` quando a base é zero ou não finita — e
 * "cresceu 0%" e "não havia contra o que comparar" levam a leituras opostas na
 * tela. Em `roas` e `cpa`, `null` também cobre o caso de um dos dois períodos
 * não ter a métrica calculável.
 */
export class OverviewDeltasDto {
  @ApiProperty({ type: Number, nullable: true, example: 12.4 })
  spend!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  revenue!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  conversions!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  roas!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpa!: number | null;
}

export class AnalyticsOverviewDto {
  @ApiProperty({ enum: ['7d', '30d', '90d'] })
  period!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  since!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  until!: string;

  @ApiProperty({ type: AggregatedTotalsDto })
  totals!: AggregatedTotalsDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'O par de grandezas de §10.1, via `open_waste`. **Nunca somado ao gasto.** ' +
      '`null` em workspace pessoal, que por construção não tem anúncio — e ' +
      'devolver zeros ali afirmaria que não há desperdício, que é diferente de ' +
      'não haver o que medir.',
  })
  openWaste!: Record<string, unknown> | null;

  @ApiProperty({ type: OverviewDeltasDto })
  deltas!: OverviewDeltasDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'object' },
    description: 'Os mesmos totais, por plataforma.',
  })
  byPlatform!: Record<string, AggregatedTotalsDto>;
}

export class PlatformHealthItemDto {
  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ enum: ['STRONG', 'OK', 'WEAK'] })
  health!: string;

  @ApiProperty()
  spend!: number;

  @ApiProperty()
  revenue!: number;

  @ApiProperty({ type: Number, nullable: true })
  roas!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpa!: number | null;

  @ApiProperty()
  conversions!: number;

  @ApiProperty({
    type: [String],
    example: ['ROAS < 1x', 'CTR < 0.5%'],
    description:
      'Os sinais que produziram o veredito. O rótulo sozinho não é acionável ' +
      '— "WEAK" sem motivo manda o usuário procurar o que já sabemos.',
  })
  signals!: string[];
}

export class PlatformHealthDto {
  @ApiProperty({ enum: ['7d', '30d', '90d'] })
  period!: string;

  @ApiProperty({ type: [PlatformHealthItemDto] })
  platforms!: PlatformHealthItemDto[];
}

export class CrossChannelDto {
  @ApiProperty({ enum: ['7d', '30d', '90d'] })
  period!: string;

  @ApiProperty({ enum: ['last-click', 'linear', 'blended-attribution'] })
  attribution!: string;

  @ApiProperty({ type: AggregatedTotalsDto })
  totals!: AggregatedTotalsDto;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'object' } })
  byPlatform!: Record<string, AggregatedTotalsDto>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'Receita por plataforma, em moeda-base, dividida pela opção escolhida. ' +
      '**Não é atribuição** — é redistribuição declarada da receita que as ' +
      'plataformas reportam, e a soma é sempre o total observado.',
  })
  attributedRevenue!: Record<string, number>;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  timeseries!: unknown[];
}

export class BudgetAllocationItemDto {
  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ example: 0.62 })
  currentShare!: number;

  @ApiProperty({ example: 0.71 })
  recommendedShare!: number;

  @ApiProperty({
    enum: ['INCREASE', 'DECREASE', 'HOLD'],
    description:
      '`HOLD` abaixo de 2 pontos de diferença — ruído não vira recomendação.',
  })
  direction!: string;

  @ApiProperty({ example: 'Based on ROAS 3.20x over 30d' })
  rationale!: string;
}

/**
 * O par que sustenta a realocação: o canal que cede e o que recebe.
 *
 * Os dois vêm inteiros — ROAS, gasto, receita, conversões e fatia — em vez de
 * só o nome. Quem lê a frase precisa poder conferi-la sem uma segunda chamada,
 * e um card que afirma "60% maior" sem mostrar os dois lados pede confiança em
 * vez de oferecer evidência.
 */
export class CrossChannelInsightSideDto {
  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ example: 'Google' })
  label!: string;

  @ApiProperty({ example: 3.2 })
  roas!: number;

  @ApiProperty()
  spendBase!: number;

  @ApiProperty()
  revenueBase!: number;

  @ApiProperty()
  conversions!: number;

  @ApiProperty({ example: 0.38, description: 'Fatia do investimento total.' })
  spendShare!: number;
}

/** O que sustenta — ou impede — a afirmação. Presente nos dois casos (P7). */
export class CrossChannelInsightEvidenceDto {
  @ApiProperty()
  periodDays!: number;

  @ApiProperty({ description: 'Canais com gasto na janela.' })
  platformsDelivering!: number;

  @ApiProperty({
    description:
      'Quantos ficaram fora por conversões ou fatia de gasto abaixo do piso. ' +
      'O número, não só o rótulo — "alguns canais não entraram" não é usável.',
  })
  platformsBelowFloor!: number;

  @ApiProperty({
    description: 'Linhas que entraram como zero por câmbio não coletado (M1).',
  })
  excludedPendingNormalization!: number;

  @ApiProperty({ example: 10 })
  minConversionsPerSide!: number;

  @ApiProperty({ example: 15 })
  materialGapPct!: number;
}

/**
 * O insight cross-channel — a versão em prosa da tabela de realocação.
 *
 * **`kind` discrimina, e `UNAVAILABLE` não é erro.** Um canal só, volume abaixo
 * do piso ou diferença dentro do ruído devolvem `kind: "UNAVAILABLE"` com
 * `reason` e um `headline` que explica — nunca uma recomendação fraca, e nunca
 * um card vazio, que o usuário leria como tela quebrada.
 *
 * **`projectedRevenueGainBase` é aritmética declarada, não previsão:** é
 * `valor movido × (ROAS do receptor − ROAS do doador)`, que assume retorno
 * marginal igual ao médio. A premissa é falsa por construção — leilão satura,
 * público tem teto —, e é por isso que `assumptions[]` viaja junto com o número
 * em vez de ficar a critério de quem renderiza.
 *
 * **Determinístico inteiro, sem IA** (P4): o card não muda de forma quando um
 * provider cai.
 */
export class CrossChannelInsightDto {
  @ApiProperty({ enum: ['REALLOCATION', 'UNAVAILABLE'] })
  kind!: string;

  @ApiProperty({
    enum: [
      'NO_DELIVERY',
      'SINGLE_PLATFORM',
      'CURRENCY_UNDECLARED',
      'ROAS_NOT_RESOLVABLE',
      'BELOW_EVIDENCE_FLOOR',
      'NO_MATERIAL_GAP',
    ],
    required: false,
    description:
      'Só em `UNAVAILABLE`. `NO_MATERIAL_GAP` é veredito apurado ("não vale ' +
      'realocar"), não lacuna de dado — e `meta.evidenceSufficiency` o declara ' +
      'como `SUFFICIENT` justamente por isso.',
  })
  reason?: string;

  @ApiProperty({
    example:
      'Google entrega ROAS 62% maior que Meta nos últimos 30 dias (3,20x ' +
      'contra 1,98x). Realocar 10% do investimento de Meta — R$ 12.400 — ' +
      'projeta R$ 15.100 a mais em receita, mantido o ROAS observado no ' +
      'volume adicional.',
    description:
      'Texto determinístico em pt-BR. Presente **sempre**, inclusive em ' +
      '`UNAVAILABLE`, onde explica o que falta.',
  })
  headline!: string;

  @ApiProperty({ type: String, required: false, example: 'BRL' })
  baseCurrency?: string;

  @ApiProperty({ type: CrossChannelInsightSideDto, required: false })
  from?: CrossChannelInsightSideDto;

  @ApiProperty({ type: CrossChannelInsightSideDto, required: false })
  to?: CrossChannelInsightSideDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    example: 62,
    description:
      '`null` quando o doador não registrou receita: a razão não é definida, e ' +
      'a comparação no texto passa a ser absoluta.',
  })
  roasGapPct?: number | null;

  @ApiProperty({
    required: false,
    example: 0.1,
    description:
      'Fatia do investimento do doador que a sugestão move. Conservadora de ' +
      'propósito: quanto maior a fatia, mais longe do observado a projeção opera.',
  })
  shiftShare?: number;

  @ApiProperty({ required: false })
  shiftAmountBase?: number;

  @ApiProperty({
    required: false,
    description: 'O ganho **incremental**, não a receita total.',
  })
  projectedRevenueGainBase?: number;

  @ApiProperty({ type: Number, nullable: true, required: false })
  currentRoas?: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    required: false,
    description:
      'ROAS combinado se a realocação se sustentar. O gasto total não muda — ' +
      'realocar não é aumentar orçamento.',
  })
  projectedRoas?: number | null;

  @ApiProperty({
    type: [String],
    required: false,
    description:
      'As ressalvas que a projeção carrega. Nunca vazio em `REALLOCATION`.',
  })
  assumptions?: string[];

  @ApiProperty({ type: CrossChannelInsightEvidenceDto })
  evidence!: CrossChannelInsightEvidenceDto;
}

export class BudgetAllocationDto {
  @ApiProperty({ enum: ['7d', '30d', '90d'] })
  period!: string;

  @ApiProperty()
  totalSpend!: number;

  @ApiProperty()
  totalRevenue!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'BRL',
    description:
      'A moeda-base em que `totalSpend`, `totalRevenue` e os valores do insight ' +
      'estão. Sem ela, o mix recomendado seria formatado num real presumido — ' +
      'que é o que a tela fazia antes desta rota declarar a unidade.',
  })
  baseCurrency!: string | null;

  @ApiProperty({
    type: [BudgetAllocationItemDto],
    description:
      'Realocação **entre canais**, no nível da conta. Não confundir com ' +
      '`/recommendations`, que propõe ação executável sobre um anúncio.',
  })
  recommendations!: BudgetAllocationItemDto[];

  @ApiProperty({
    type: CrossChannelInsightDto,
    description:
      'A mesma realocação em uma frase com número. Mora nesta rota, e não em ' +
      '`/cross-channel`, porque lá o seletor de atribuição redistribui receita ' +
      'por fatia de gasto — uma projeção construída sobre isso mediria a ' +
      'própria redistribuição.',
  })
  insight!: CrossChannelInsightDto;
}

// ─── Ritmo de orçamento (N1) ─────────────────────────────────────────────────

export class BudgetPacingRowDto {
  @ApiProperty()
  campaignId!: string;

  @ApiProperty()
  campaignName!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({
    description:
      'O orçamento **da campanha**, ou a soma dos conjuntos — nunca os dois. ' +
      'Com CBO ele vive na campanha e os conjuntos vêm nulos; somar os dois ' +
      'níveis dobraria o teto de toda conta que usa CBO.',
  })
  dailyBudgetBase!: number;

  @ApiProperty()
  spendBase!: number;

  @ApiProperty({
    description:
      'O que a régua do orçamento previa para os dias **já decorridos**. ' +
      'Comparar gasto de 5 dias com orçamento de 30 diria que toda conta ' +
      'economiza, sempre.',
  })
  expectedSpendBase!: number;

  @ApiProperty()
  burnRateBase!: number;

  @ApiProperty({ enum: ['OVERSPENDING', 'HEALTHY', 'UNDERSPENDING'] })
  status!: string;
}

export class BudgetPacingDto {
  @ApiProperty({ enum: ['7d', '30d', '90d'] })
  period!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  since!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  until!: string;

  @ApiProperty({ type: String, nullable: true, example: 'BRL' })
  baseCurrency!: string | null;

  @ApiProperty()
  budgetBase!: number;

  @ApiProperty()
  spendBase!: number;

  @ApiProperty()
  expectedSpendBase!: number;

  @ApiProperty()
  burnRateBase!: number;

  @ApiProperty({
    enum: ['OVERSPENDING', 'HEALTHY', 'UNDERSPENDING'],
    description:
      'Faixa de tolerância de ±10% — oscilação de leilão não é desvio.',
  })
  status!: string;

  @ApiProperty({ type: [BudgetPacingRowDto] })
  rows!: BudgetPacingRowDto[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Gasto por dia contra o teto diário — mostra **em que dia** o ritmo ' +
      'estourou, que é o que o total não diz. Não há linha de previsão: a ' +
      'janela é móvel e não tem dia futuro.',
  })
  timeseries!: Array<{ date: string; spendBase: number; allowedBase: number }>;

  @ApiProperty({
    description:
      'Campanhas sem orçamento diário resolvível — em geral orçamento de vôo ' +
      '(`lifetimeBudget`), que é teto do período inteiro e não um ritmo.',
  })
  excludedWithoutDailyBudget!: number;

  @ApiProperty({
    description:
      'Campanhas cujo orçamento não pôde ser convertido para a moeda-base por ' +
      'falta de taxa. Entram fora do total em vez de somarem moedas diferentes.',
  })
  excludedWithoutRate!: number;
}

export class UncoveredCampaignDto {
  @ApiProperty()
  campaignId!: string;

  @ApiProperty({ example: 'Smart+ — Vendas' })
  campaignName!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ type: String, nullable: true })
  rawStatus!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'WEB_CONVERSIONS' })
  objective!: string | null;

  @ApiProperty()
  adAccountName!: string;

  @ApiProperty({
    enum: ['NO_ANALYZABLE_ADS'],
    description:
      'Campanha ativa sem nenhum anúncio que o sync consiga ler — tipicamente ' +
      'um formato automatizado que a plataforma não expõe como anúncio.',
  })
  reason!: string;
}

export class CoverageDto {
  @ApiProperty({ type: [UncoveredCampaignDto] })
  uncoveredCampaigns!: UncoveredCampaignDto[];

  @ApiProperty({ example: 2 })
  total!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { TIKTOK: 2 },
  })
  byPlatform!: Record<string, number>;
}
