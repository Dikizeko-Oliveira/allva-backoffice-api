import {
  MEASUREMENT_VERSION,
  measureOutcome,
  type MeasurementInput,
} from './outcome-measurement';

/**
 * A medição de C4 — **o que o produto passa a afirmar sobre o próprio acerto**.
 *
 * É a última das funções puras que decidem sobre a mídia de alguém, e a mais
 * exposta: o número que sai daqui alimenta P8, e P8 é o que autoriza (ou não) a
 * automação supervisionada de §20-H3. Um `>` invertido aqui não quebra nada
 * visivelmente — só faz a Allva concluir que acerta mais do que acerta.
 */

function input(overrides: Partial<MeasurementInput> = {}): MeasurementInput {
  return {
    kind: 'SPEND_AVOIDED',
    windowDays: 14,
    pre: {
      spendBase: 1_000,
      revenueBase: 500,
      conversions: 10,
      aiScore: 40,
    },
    post: { spendBase: 0, revenueBase: 0, conversions: 0, aiScore: 40 },
    observedDays: 14,
    seriesDiscontinuity: null,
    lineageAdCount: 1,
    externalStatusChange: false,
    concurrentActions: 0,
    ...overrides,
  };
}

describe('o sentido do delta é sempre "positivo é melhor"', () => {
  it('SPEND_AVOIDED: gasto que parou é ganho, não perda', () => {
    const result = measureOutcome(input());

    expect(result.observedDelta).toBe(1_000);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('CPA_DELTA: custo que caiu é ganho, com a subtração invertida', () => {
    // Pré: 1000/10 = 100. Pós: 400/10 = 40. O CPA caiu 60 — melhorou.
    const result = measureOutcome(
      input({
        kind: 'CPA_DELTA',
        post: {
          spendBase: 400,
          revenueBase: 500,
          conversions: 10,
          aiScore: 40,
        },
      }),
    );

    expect(result.observedDelta).toBe(60);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('REVENUE_DELTA: receita que subiu é ganho, com a subtração direta', () => {
    const result = measureOutcome(
      input({
        kind: 'REVENUE_DELTA',
        post: {
          spendBase: 1_000,
          revenueBase: 900,
          conversions: 18,
          aiScore: 40,
        },
      }),
    );

    expect(result.observedDelta).toBe(400);
    expect(result.verdict).toBe('IMPROVED');
  });

  it('um gasto que SUBIU depois de uma recomendação de economia é WORSENED', () => {
    const result = measureOutcome(
      input({
        post: {
          spendBase: 1_500,
          revenueBase: 500,
          conversions: 10,
          aiScore: 40,
        },
      }),
    );

    expect(result.observedDelta).toBe(-500);
    expect(result.verdict).toBe('WORSENED');
  });
});

describe('o que a medição se recusa a afirmar', () => {
  /**
   * O modo de falha mais caro do sprint: cegueira lida como sucesso. Um anúncio
   * pausado gasta zero **e é observado** gastando zero; uma conta inalcançável
   * não produz linha nenhuma. Sem este corte, a segunda vira "economia de 100%".
   */
  it('cobertura abaixo de 60% da janela ⇒ INCONCLUSIVE, sem delta', () => {
    const result = measureOutcome(input({ observedDays: 5 }));

    expect(result.observedDelta).toBeNull();
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.confidence).toBe(0);
  });

  it('variação dentro do ruído de leilão é UNCHANGED, não uma vitória pequena', () => {
    // 3% de queda de gasto: abaixo do limiar de 5%.
    const result = measureOutcome(
      input({
        post: {
          spendBase: 970,
          revenueBase: 500,
          conversions: 10,
          aiScore: 40,
        },
      }),
    );

    expect(result.verdict).toBe('UNCHANGED');
  });

  it('CPA sem conversão em uma das pontas não é "CPA infinito"', () => {
    // Sem esta guarda, toda pausa de anúncio sem conversão viraria melhoria
    // astronômica — e o kind que mais dispara é justamente esse.
    const result = measureOutcome(
      input({
        kind: 'CPA_DELTA',
        post: { spendBase: 0, revenueBase: 0, conversions: 0, aiScore: 40 },
      }),
    );

    expect(result.observedDelta).toBeNull();
    expect(result.verdict).toBe('INCONCLUSIVE');
  });

  it('SCORE_DELTA sem score em uma das pontas não conclui', () => {
    const result = measureOutcome(
      input({
        kind: 'SCORE_DELTA',
        post: { spendBase: 0, revenueBase: 0, conversions: 0, aiScore: null },
      }),
    );

    expect(result.observedDelta).toBeNull();
  });

  it('sem gasto na janela pré não há linha de base a comparar', () => {
    const result = measureOutcome(
      input({
        pre: { spendBase: 0, revenueBase: 0, conversions: 0, aiScore: 40 },
      }),
    );

    expect(result.observedDelta).toBeNull();
    expect(result.confounders.map((c) => c.code)).toContain('NO_PRE_BASELINE');
  });
});

describe('confounders — o que se sabe contra o número (D6)', () => {
  it('sucessão de linhagem entra como confounder, não como erro', () => {
    // A janela pós atravessa dois anúncios porque a ação recriou o anúncio.
    // Medir continua certo — é a linhagem que dá continuidade —, mas quem lê
    // precisa saber que o "mesmo anúncio" mudou de id no meio.
    const result = measureOutcome(input({ lineageAdCount: 2 }));

    expect(result.confounders.map((c) => c.code)).toContain(
      'LINEAGE_SUCCESSION',
    );
    expect(result.observedDelta).toBe(1_000);
  });

  it('descontinuidade, ação concorrente e mudança externa acumulam', () => {
    const result = measureOutcome(
      input({
        seriesDiscontinuity: 'NEW_SIGNAL',
        concurrentActions: 2,
        externalStatusChange: true,
      }),
    );

    expect(result.confounders.map((c) => c.code).sort()).toEqual([
      'CONCURRENT_ACTIONS',
      'EXTERNAL_STATUS_CHANGE',
      'SERIES_DISCONTINUITY',
    ]);
  });

  it('cada confounder desconta a confiança, com piso — nunca a zera', () => {
    // Zerar equivaleria a apagar a linha, e apagar perde o histórico que
    // §20-H3 precisa acumular ao longo de 90 dias.
    const clean = measureOutcome(input());
    const muddy = measureOutcome(
      input({
        seriesDiscontinuity: 'CURRENCY_REBASED',
        concurrentActions: 3,
        externalStatusChange: true,
        lineageAdCount: 4,
      }),
    );

    expect(clean.confidence).toBe(1);
    expect(muddy.confidence).toBeGreaterThanOrEqual(0.1);
    expect(muddy.confidence).toBeLessThan(clean.confidence);
    // O veredito continua sendo emitido: confiança baixa é informação, não
    // motivo para silêncio — o silêncio é o corte de cobertura, acima.
    expect(muddy.verdict).toBe('IMPROVED');
  });

  it('janela parcialmente observada é declarada mesmo quando mede', () => {
    // 10 de 14 dias passa o corte de 60% e ainda assim é parcial.
    const result = measureOutcome(input({ observedDays: 10 }));

    expect(result.verdict).toBe('IMPROVED');
    expect(result.confounders.map((c) => c.code)).toContain(
      'PARTIAL_OBSERVATION',
    );
    // 10/14 de cobertura, menos os 0,15 do próprio confounder de parcialidade.
    expect(result.confidence).toBeCloseTo(0.5643, 3);
  });
});

describe('secondaryDeltas — contexto, fora das métricas de P8 (DEC-6)', () => {
  it('traz todas as grandezas, e nenhuma delas é o delta primário', () => {
    const result = measureOutcome(
      input({
        post: {
          spendBase: 600,
          revenueBase: 800,
          conversions: 16,
          aiScore: 55,
        },
      }),
    );

    expect(result.observedDelta).toBe(400);
    expect(result.secondaryDeltas).toMatchObject({
      spendBase: -400,
      revenueBase: 300,
      conversions: 6,
      aiScore: 15,
    });
  });

  it('grandeza indefinida vira null, nunca Infinity', () => {
    const result = measureOutcome(
      input({
        pre: {
          spendBase: 1_000,
          revenueBase: 0,
          conversions: 0,
          aiScore: null,
        },
        post: { spendBase: 0, revenueBase: 0, conversions: 0, aiScore: null },
      }),
    );

    expect(result.secondaryDeltas.cpaBase).toBeNull();
    expect(result.secondaryDeltas.aiScore).toBeNull();
  });
});

it('a versão da medição é declarada e estável', () => {
  // §20-H3 mede acurácia ao longo de 90 dias, e em 90 dias esta lógica muda ao
  // menos uma vez. Sem a versão, duas medidas distintas entram no mesmo
  // denominador e o número que autoriza automação vira média delas.
  expect(MEASUREMENT_VERSION).toMatch(/^measure-\d+\.\d+\.\d+$/);
});
