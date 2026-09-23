import {
  computeCrossChannelInsight,
  MATERIAL_ROAS_GAP_PCT,
  MIN_CONVERSIONS_PER_SIDE,
  MIN_DONOR_SPEND_SHARE,
  REALLOCATION_SHIFT,
  type CrossChannelInsightInput,
  type PlatformAggregate,
} from './cross-channel-insight';

function platform(
  overrides: Partial<PlatformAggregate> & {
    platform: PlatformAggregate['platform'];
  },
): PlatformAggregate {
  const spendBase = overrides.spendBase ?? 10_000;
  const revenueBase = overrides.revenueBase ?? 20_000;

  return {
    spendBase,
    revenueBase,
    roas: spendBase > 0 ? revenueBase / spendBase : null,
    conversions: 100,
    ...overrides,
  };
}

function input(
  platforms: PlatformAggregate[],
  overrides: Partial<CrossChannelInsightInput> = {},
): CrossChannelInsightInput {
  const totalSpendBase = platforms.reduce((sum, p) => sum + p.spendBase, 0);
  const totalRevenueBase = platforms.reduce((sum, p) => sum + p.revenueBase, 0);

  return {
    platforms,
    totalSpendBase,
    totalRevenueBase,
    baseCurrency: 'BRL',
    periodDays: 30,
    excludedPendingNormalization: 0,
    ...overrides,
  };
}

describe('computeCrossChannelInsight — a recusa em afirmar', () => {
  it('sem veiculação não há canais a comparar', () => {
    const insight = computeCrossChannelInsight(input([]));

    expect(insight.kind).toBe('UNAVAILABLE');
    expect(insight).toMatchObject({ reason: 'NO_DELIVERY' });
  });

  /**
   * O caso mais provável em conta nova: uma integração conectada, as outras
   * não. Recomendar realocação exige para onde realocar.
   */
  it('um canal só não produz recomendação, e o texto diz qual é', () => {
    const insight = computeCrossChannelInsight(
      input([platform({ platform: 'META' })]),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'SINGLE_PLATFORM',
    });
    expect(insight.headline).toContain('Meta');
  });

  it('sem moeda-base declarada não afirma valor a realocar', () => {
    const insight = computeCrossChannelInsight(
      input(
        [
          platform({
            platform: 'META',
            spendBase: 10_000,
            revenueBase: 10_000,
          }),
          platform({
            platform: 'GOOGLE',
            spendBase: 10_000,
            revenueBase: 30_000,
          }),
        ],
        { baseCurrency: null },
      ),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'CURRENCY_UNDECLARED',
    });
  });

  /**
   * ROAS sobre três conversões descreve três eventos, não o canal. O piso
   * incide nos dois lados: receita subnotificada no doador fabrica a diferença
   * inteira, e é o ROAS do receptor que multiplica o valor movido.
   */
  it('abaixo do piso de conversões não compara, e conta quantos ficaram fora', () => {
    const insight = computeCrossChannelInsight(
      input([
        platform({
          platform: 'META',
          spendBase: 10_000,
          revenueBase: 10_000,
          conversions: MIN_CONVERSIONS_PER_SIDE,
        }),
        platform({
          platform: 'GOOGLE',
          spendBase: 10_000,
          revenueBase: 40_000,
          conversions: MIN_CONVERSIONS_PER_SIDE - 1,
        }),
      ]),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'BELOW_EVIDENCE_FLOOR',
    });
    expect(insight.evidence.platformsDelivering).toBe(2);
    expect(insight.evidence.platformsBelowFloor).toBe(1);
  });

  /** 10% de trocados é sugestão que gasta a atenção do usuário para nada. */
  it('canal com fatia de gasto irrelevante não entra na comparação', () => {
    const insight = computeCrossChannelInsight(
      input([
        platform({
          platform: 'META',
          spendBase: 100_000,
          revenueBase: 100_000,
        }),
        // 1% do investimento — abaixo dos 5% exigidos.
        platform({ platform: 'TIKTOK', spendBase: 1_010, revenueBase: 10_000 }),
      ]),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'BELOW_EVIDENCE_FLOOR',
    });
    expect(MIN_DONOR_SPEND_SHARE).toBe(0.05);
  });

  /**
   * Geração de lead sem valor de conversão: conversões existem, receita não.
   * A diferença entre zeros não recomenda nada — e o texto separa "não há
   * receita" de "não há dado".
   */
  it('sem receita em nenhum canal não há ROAS a comparar', () => {
    const insight = computeCrossChannelInsight(
      input([
        platform({ platform: 'META', spendBase: 10_000, revenueBase: 0 }),
        platform({ platform: 'GOOGLE', spendBase: 10_000, revenueBase: 0 }),
      ]),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'ROAS_NOT_RESOLVABLE',
    });
    expect(insight.headline).toContain('receita');
  });

  /**
   * O caso que separa um insight de um gerador de ruído. ROAS oscila por
   * leilão dentro da mesma janela; recomendar sobre 10% de diferença ensina o
   * usuário a ignorar o card.
   */
  it('diferença dentro do ruído é veredito de não realocar, não recomendação fraca', () => {
    const insight = computeCrossChannelInsight(
      input([
        platform({ platform: 'META', spendBase: 10_000, revenueBase: 20_000 }),
        platform({
          platform: 'GOOGLE',
          spendBase: 10_000,
          revenueBase: 22_000,
        }),
      ]),
    );

    expect(insight).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'NO_MATERIAL_GAP',
    });
    expect(insight.headline).toContain('equivalente');
  });

  it('logo acima do piso de materialidade já recomenda', () => {
    const donorRoas = 2;
    const receiverRoas = donorRoas * (1 + (MATERIAL_ROAS_GAP_PCT + 1) / 100);

    const insight = computeCrossChannelInsight(
      input([
        platform({
          platform: 'META',
          spendBase: 10_000,
          revenueBase: 10_000 * donorRoas,
        }),
        platform({
          platform: 'GOOGLE',
          spendBase: 10_000,
          revenueBase: 10_000 * receiverRoas,
        }),
      ]),
    );

    expect(insight.kind).toBe('REALLOCATION');
  });
});

describe('computeCrossChannelInsight — a projeção', () => {
  const meta = platform({
    platform: 'META',
    spendBase: 100_000,
    revenueBase: 200_000,
  });
  const google = platform({
    platform: 'GOOGLE',
    spendBase: 50_000,
    revenueBase: 160_000,
  });

  it('move do menor ROAS para o maior', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.from.platform).toBe('META');
    expect(insight.to.platform).toBe('GOOGLE');
  });

  it('a ordem de entrada não muda o par escolhido', () => {
    const direta = computeCrossChannelInsight(input([meta, google]));
    const invertida = computeCrossChannelInsight(input([google, meta]));

    expect(invertida).toEqual(direta);
  });

  /**
   * `valor movido × (ROAS do receptor − ROAS do doador)`. Meta 2,00x, Google
   * 3,20x, 10% de R$ 100 mil = R$ 10 mil movidos ⇒ R$ 12 mil de ganho.
   */
  it('o ganho é o incremental, não a receita total do valor movido', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.shiftAmountBase).toBeCloseTo(
      100_000 * REALLOCATION_SHIFT,
      6,
    );
    expect(insight.projectedRevenueGainBase).toBeCloseTo(10_000 * (3.2 - 2), 6);
  });

  /** Realocar não é aumentar orçamento: o denominador do ROAS não muda. */
  it('o ROAS projetado usa o mesmo gasto total', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.currentRoas).toBeCloseTo(360_000 / 150_000, 6);
    expect(insight.projectedRoas).toBeCloseTo(
      (360_000 + insight.projectedRevenueGainBase) / 150_000,
      6,
    );
  });

  it('a diferença de ROAS é relativa ao doador', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.roasGapPct).toBeCloseTo(60, 6);
    expect(insight.headline).toContain('60% maior');
    expect(insight.headline).toContain('3,20x contra 2,00x');
  });

  /**
   * A ressalva viaja com o número. Sem isto, a projeção volta a ser o que era
   * antes desta rota existir: uma promessa de receita sem conta atrás.
   */
  it('toda recomendação carrega as premissas da projeção', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.assumptions.length).toBeGreaterThan(0);
    expect(insight.assumptions.join(' ')).toContain('marginal');
  });

  /**
   * O que a versão fixa do card afirmava e nenhum dado sustenta. Alcance de
   * topo de funil não sai de uma série de gasto, receita e conversão.
   */
  it('não afirma nada sobre alcance nem sobre funil superior', () => {
    const insight = computeCrossChannelInsight(input([meta, google]));

    const texto = `${insight.headline} ${insight.kind === 'REALLOCATION' ? insight.assumptions.join(' ') : ''}`;
    expect(texto).not.toMatch(/alcance|funil/i);
  });

  /** Doador sem receita: a razão não é definida, e o texto vira absoluto. */
  it('doador sem receita produz gap nulo e comparação absoluta', () => {
    const insight = computeCrossChannelInsight(
      input([
        platform({ platform: 'META', spendBase: 50_000, revenueBase: 0 }),
        platform({
          platform: 'GOOGLE',
          spendBase: 50_000,
          revenueBase: 160_000,
        }),
      ]),
    );

    if (insight.kind !== 'REALLOCATION')
      throw new Error('esperava REALLOCATION');
    expect(insight.roasGapPct).toBeNull();
    expect(insight.headline).toContain('não registrou receita');
    expect(insight.projectedRevenueGainBase).toBeCloseTo(5_000 * 3.2, 6);
  });

  it('o texto sai na moeda-base declarada, não em real fixo', () => {
    const insight = computeCrossChannelInsight(
      input([meta, google], { baseCurrency: 'USD' }),
    );

    expect(insight.headline).toContain('US$');
    expect(insight.headline).not.toContain('R$');
  });

  it('propaga as linhas que ficaram fora por câmbio não coletado', () => {
    const insight = computeCrossChannelInsight(
      input([meta, google], { excludedPendingNormalization: 7 }),
    );

    expect(insight.evidence.excludedPendingNormalization).toBe(7);
  });

  it('a janela declarada é a que aparece no texto', () => {
    const insight = computeCrossChannelInsight(
      input([meta, google], { periodDays: 7 }),
    );

    expect(insight.headline).toContain('últimos 7 dias');
    expect(insight.evidence.periodDays).toBe(7);
  });
});
