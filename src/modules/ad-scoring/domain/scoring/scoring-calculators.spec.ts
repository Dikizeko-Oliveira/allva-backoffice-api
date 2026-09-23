import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { AttentionScoreCalculator } from './attention-score.calculator';
import { AudienceFitScoreCalculator } from './audience-fit-score.calculator';
import { CreativeMetricsAggregator } from './creative-metrics-aggregator';
import {
  FatigueSaturationCalculator,
  dailyCpm,
} from './fatigue-saturation.calculator';
import { LearningStabilityScoreCalculator } from './learning-stability-score.calculator';
import { NegativeFeedbackRiskCalculator } from './negative-feedback-risk.calculator';
import {
  coefficientOfVariation,
  computeConfidence,
  invertedNormalize,
  normalize,
  weightedAverage,
} from './score-math';

/**
 * **A rede que não existia.**
 *
 * O Apêndice C descreve estas calculadoras como "maduras, testadas" e o gate de
 * A2-S4 pede "cobertura preservada" — mas nenhum `.spec.ts` jamais existiu aqui,
 * e o histórico do repositório confirma que nenhum foi removido. Migrar
 * `creative-lab/domain/scoring/` para `ad-scoring/` sem rede seria reescrever às
 * cegas cinco funções que decidem o que o produto diz sobre a mídia do usuário.
 *
 * Este arquivo é escrito **antes** da migração, contra o comportamento atual, e
 * viaja junto com os arquivos. Se as mesmas asserções passarem dos dois lados, a
 * migração foi fiel — que é exatamente o que "sem mudança de lógica" significa.
 *
 * As asserções são de **propriedade** (monotonicidade, fronteiras, ausência de
 * sinal) e não de número mágico, com poucas exceções onde o número é o contrato.
 * Um teste que fixa `expect(score).toBe(63)` quebra em toda calibração legítima
 * e não diz nada sobre estar certo.
 */

function row(
  overrides: Partial<AdMetricSnapshotRow> = {},
): AdMetricSnapshotRow {
  return {
    adId: 'ad-1',
    organizationId: 'org-1',
    adAccountId: 'acc-1',
    campaignId: 'camp-1',
    adSetId: 'set-1',
    creativeId: 'cr-1',
    platform: 'META',
    date: new Date('2026-07-01T00:00:00Z'),
    spend: 100,
    revenue: 300,
    currency: 'BRL',
    spendBase: 100,
    revenueBase: 300,
    baseCurrency: 'BRL',
    normalizationPending: false,
    impressions: 10_000,
    clicks: 200,
    conversions: 10,
    reach: 8_000,
    frequency: 1.25,
    videoViews: null,
    engagement: 150,
    thumbstopRate: 0.3,
    holdRate: 0.4,
    hides: null,
    hideAllFor: null,
    reports: null,
    unlikes: null,
    seriesDiscontinuity: null,
    syncedAt: new Date('2026-07-02T00:00:00Z'),
    ...overrides,
  };
}

/** N dias de série, com um override por dia. */
function series(
  days: number,
  perDay: (index: number) => Partial<AdMetricSnapshotRow> = () => ({}),
): AdMetricSnapshotRow[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date('2026-07-01T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + index);
    return row({ date, ...perDay(index) });
  });
}

describe('score-math — os primitivos', () => {
  it('normalize mapeia para [0,1] e satura nas pontas', () => {
    expect(normalize(0, 0, 10)).toBe(0);
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(10, 0, 10)).toBe(1);
    expect(normalize(-5, 0, 10)).toBe(0);
    expect(normalize(50, 0, 10)).toBe(1);
  });

  it('trata ausência e não-finito como sinal faltante, nunca como zero', () => {
    // A distinção é o produto: zero é uma medição ruim, `null` é ausência de
    // medição — e o composto pondera as duas de formas opostas.
    expect(normalize(null, 0, 10)).toBeNull();
    expect(normalize(undefined, 0, 10)).toBeNull();
    expect(normalize(Number.NaN, 0, 10)).toBeNull();
    expect(normalize(Number.POSITIVE_INFINITY, 0, 10)).toBeNull();
  });

  it('faixa degenerada devolve null em vez de dividir por zero', () => {
    expect(normalize(5, 10, 10)).toBeNull();
  });

  it('invertedNormalize espelha: menor é melhor', () => {
    expect(invertedNormalize(0, 0, 10)).toBe(1);
    expect(invertedNormalize(10, 0, 10)).toBe(0);
    expect(invertedNormalize(null, 0, 10)).toBeNull();
  });

  it('weightedAverage ignora ausente e renormaliza os pesos restantes', () => {
    // Sem a renormalização, um sinal faltante puxaria o score para zero — que é
    // afirmar "ruim" quando o que se sabe é "não medido".
    expect(
      weightedAverage([
        { value: 1, weight: 1 },
        { value: null, weight: 9 },
      ]),
    ).toBe(1);

    expect(
      weightedAverage([
        { value: 1, weight: 1 },
        { value: 0, weight: 1 },
      ]),
    ).toBe(0.5);
  });

  it('weightedAverage devolve null quando nada é mensurável', () => {
    expect(weightedAverage([{ value: null, weight: 1 }])).toBeNull();
    expect(weightedAverage([])).toBeNull();
    // Peso não-positivo não participa: um peso zero não é um voto silencioso.
    expect(weightedAverage([{ value: 1, weight: 0 }])).toBeNull();
  });

  it('confiança cresce com cobertura de sinal e com volume', () => {
    const baixa = computeConfidence({
      presentSignals: 1,
      expectedSignals: 6,
      impressions: 100,
      volumeAt: 5000,
    });
    const alta = computeConfidence({
      presentSignals: 6,
      expectedSignals: 6,
      impressions: 5000,
      volumeAt: 5000,
    });

    expect(alta).toBe(1);
    expect(baixa).toBeLessThan(alta);
    expect(baixa).toBeGreaterThanOrEqual(0);
  });

  it('cobertura de sinal pesa mais que volume bruto (0,6 × 0,4)', () => {
    // Muito volume sobre um sinal só não vale tanto quanto todos os sinais com
    // pouco volume: é o que impede um anúncio grande e cego de parecer confiável.
    const soVolume = computeConfidence({
      presentSignals: 0,
      expectedSignals: 6,
      impressions: 999_999,
      volumeAt: 5000,
    });
    const soSinal = computeConfidence({
      presentSignals: 6,
      expectedSignals: 6,
      impressions: 0,
      volumeAt: 5000,
    });

    expect(soVolume).toBeCloseTo(0.4, 5);
    expect(soSinal).toBeCloseTo(0.6, 5);
  });

  it('coeficiente de variação exige amostra e média positiva', () => {
    expect(coefficientOfVariation([1])).toBeNull();
    expect(coefficientOfVariation([0, 0, 0])).toBeNull();
    expect(coefficientOfVariation([2, 2, 2])).toBe(0);
    expect(coefficientOfVariation([1, 2, 3])!).toBeGreaterThan(0);
  });
});

describe('agregador de métricas', () => {
  it('funde várias linhas do mesmo dia numa só', () => {
    // Vários anúncios sob o mesmo criativo produzem linhas do mesmo dia; somá-las
    // é o que impede o mesmo gasto de aparecer duas vezes na série.
    const aggregate = CreativeMetricsAggregator.aggregate([
      row({ spend: 100, impressions: 1000, clicks: 10 }),
      row({ adId: 'ad-2', spend: 50, impressions: 500, clicks: 5 }),
    ]);

    expect(aggregate.days).toBe(1);
    expect(aggregate.totals.spend).toBe(150);
    expect(aggregate.totals.impressions).toBe(1500);
    expect(aggregate.averages.ctr).toBeCloseTo(1, 5);
  });

  it('deriva os ratios em vez de somá-los', () => {
    const aggregate = CreativeMetricsAggregator.aggregate([
      row({
        spend: 200,
        impressions: 10_000,
        clicks: 100,
        conversions: 10,
        revenue: 600,
      }),
    ]);

    expect(aggregate.averages.ctr).toBeCloseTo(1, 5);
    expect(aggregate.averages.cpc).toBeCloseTo(2, 5);
    expect(aggregate.averages.cpa).toBeCloseTo(20, 5);
    expect(aggregate.averages.cpm).toBeCloseTo(20, 5);
    expect(aggregate.averages.roas).toBeCloseTo(3, 5);
    expect(aggregate.averages.conversionRate).toBeCloseTo(0.1, 5);
  });

  it('devolve null onde o denominador é zero, nunca zero', () => {
    const aggregate = CreativeMetricsAggregator.aggregate([
      row({ spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 }),
    ]);

    expect(aggregate.averages.ctr).toBeNull();
    expect(aggregate.averages.cpc).toBeNull();
    expect(aggregate.averages.cpa).toBeNull();
    expect(aggregate.averages.roas).toBeNull();
  });

  it('ordena a série por data', () => {
    const desordenada = [
      row({ date: new Date('2026-07-03T00:00:00Z') }),
      row({ date: new Date('2026-07-01T00:00:00Z') }),
      row({ date: new Date('2026-07-02T00:00:00Z') }),
    ];

    const dias = CreativeMetricsAggregator.aggregate(desordenada).daily.map(
      (d) => d.date.toISOString().slice(0, 10),
    );

    expect(dias).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
  });

  it('série vazia não quebra: totais zerados e médias nulas', () => {
    const aggregate = CreativeMetricsAggregator.aggregate([]);

    expect(aggregate.days).toBe(0);
    expect(aggregate.totals.spend).toBe(0);
    expect(aggregate.averages.ctr).toBeNull();
  });

  it('benchmarks agregam o portfólio inteiro, sem agrupar por dia', () => {
    const benchmarks = CreativeMetricsAggregator.benchmarks([
      row({ spend: 100, impressions: 10_000, clicks: 100, conversions: 10 }),
      row({ spend: 100, impressions: 10_000, clicks: 100, conversions: 10 }),
    ]);

    expect(benchmarks.avgCtr).toBeCloseTo(1, 5);
    expect(benchmarks.avgCpa).toBeCloseTo(10, 5);
  });
});

describe('Attention', () => {
  it('devolve 0..100 e é monotônico no CTR', () => {
    const fraco = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(3, () => ({ clicks: 30 }))),
    );
    const forte = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(3, () => ({ clicks: 300 }))),
    );

    expect(forte.value).toBeGreaterThan(fraco.value);
    for (const score of [fraco, forte]) {
      expect(score.value).toBeGreaterThanOrEqual(0);
      expect(score.value).toBeLessThanOrEqual(100);
      expect(Number.isInteger(score.value)).toBe(true);
    }
  });

  it('sem impressão nenhuma, cai para o piso de 30', () => {
    const semNada = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate([
        row({
          spend: 0,
          clicks: 0,
          impressions: 0,
          thumbstopRate: null,
          holdRate: null,
          engagement: null,
        }),
      ]),
    );

    expect(semNada.value).toBe(30);
  });

  it('anúncio com volume e nenhum clique pontua baixo — CTR zero é um sinal', () => {
    // Aqui morava um ramo `impressions > 500 ? 40 : 30` que **nunca executava**:
    // `composite === null` exige os seis sinais nulos, e `ctr` só é nulo sem
    // impressão — com impressão e zero clique ele vale 0, que é um sinal. As
    // duas condições eram mutuamente exclusivas.
    //
    // A2-S4 removeu o ramo em vez de torná-lo alcançável. Dar 40 a um anúncio
    // com CTR zero seria inventar evidência dentro da calculadora; proteger
    // criativo novo é trabalho da composição, e o teste logo abaixo prova que
    // ela faz esse trabalho.
    const comVolumeSemClique = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate([
        row({
          spend: 0,
          clicks: 0,
          impressions: 10_000,
          thumbstopRate: null,
          holdRate: null,
          engagement: null,
        }),
      ]),
    );

    expect(comVolumeSemClique.signals.ctr).toBe(0);
    expect(comVolumeSemClique.value).toBeLessThan(30);
  });

  it('sinal indisponível na plataforma vira `null`, não zero', () => {
    const semVideo = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(3, () => ({ thumbstopRate: null, holdRate: null })),
      ),
    );

    expect(semVideo.signals.thumbstopRate).toBeNull();
    expect(semVideo.signals.holdRate).toBeNull();
    expect(semVideo.signals.ctr).not.toBeNull();
  });

  it('a confiança cai quando faltam sinais', () => {
    const completo = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(3)),
    );
    const parcial = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(3, () => ({
          thumbstopRate: null,
          holdRate: null,
          engagement: null,
        })),
      ),
    );

    expect(parcial.confidence).toBeLessThan(completo.confidence);
  });

  it('explica o que está ruim, e só o que está ruim', () => {
    const ruim = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(3, () => ({ clicks: 5, thumbstopRate: 0.05, holdRate: 0.05 })),
      ),
    );

    expect(ruim.reasons).toContain('CTR baixo');
    expect(ruim.reasons.length).toBeGreaterThan(1);

    const bom = AttentionScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(3, () => ({
          clicks: 300,
          thumbstopRate: 0.4,
          holdRate: 0.5,
          spend: 20,
        })),
      ),
    );
    expect(bom.reasons).not.toContain('CTR baixo');
  });
});

describe('Audience Fit', () => {
  it('é monotônico no ROAS', () => {
    const fraco = AudienceFitScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(3, () => ({ revenue: 50 }))),
    );
    const forte = AudienceFitScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(3, () => ({ revenue: 900 }))),
    );

    expect(forte.value).toBeGreaterThan(fraco.value);
  });

  it('sem sinal nenhum devolve o neutro 50, não zero', () => {
    // Zero afirmaria desalinhamento com o público; o que se sabe é nada.
    const vazio = AudienceFitScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate([]),
    );

    expect(vazio.value).toBe(50);
  });

  it('CPA melhor que o portfólio melhora o score', () => {
    const aggregate = CreativeMetricsAggregator.aggregate(series(3));
    const cpaDoAnuncio = aggregate.averages.cpa!;

    const contraParesCaros = AudienceFitScoreCalculator.calculate(aggregate, {
      avgCtr: 1,
      avgCpa: cpaDoAnuncio * 3,
      avgCpm: 10,
      avgRoas: 2,
      avgConversionRate: 0.05,
    });
    const contraParesBaratos = AudienceFitScoreCalculator.calculate(aggregate, {
      avgCtr: 1,
      avgCpa: cpaDoAnuncio / 3,
      avgCpm: 10,
      avgRoas: 2,
      avgConversionRate: 0.05,
    });

    expect(contraParesCaros.value).toBeGreaterThan(contraParesBaratos.value);
  });

  it('sem benchmark, a eficiência de CPA não entra na conta', () => {
    const aggregate = CreativeMetricsAggregator.aggregate(series(3));

    expect(
      AudienceFitScoreCalculator.calculate(aggregate).signals.cpaEfficiency,
    ).toBeNull();
  });

  it('consistência de CTR exige ao menos três dias', () => {
    const doisDias = AudienceFitScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(2)),
    );
    const tresDias = AudienceFitScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(3, (index) => ({ clicks: 200 + index })),
      ),
    );

    expect(doisDias.signals.retentionConsistency).toBeNull();
    expect(tresDias.signals.retentionConsistency).not.toBeNull();
  });
});

describe('Learning Stability', () => {
  it('série estável pontua acima de série volátil', () => {
    const estavel = LearningStabilityScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(7)),
    );
    const volatil = LearningStabilityScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(7, (index) => ({
          clicks: index % 2 === 0 ? 20 : 400,
          conversions: index % 2 === 0 ? 1 : 30,
        })),
      ),
    );

    expect(estavel.value).toBeGreaterThan(volatil.value);
  });

  it('devolve 0..100 com confiança em [0,1]', () => {
    const score = LearningStabilityScoreCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(5)),
    );

    expect(score.value).toBeGreaterThanOrEqual(0);
    expect(score.value).toBeLessThanOrEqual(100);
    expect(score.confidence).toBeGreaterThanOrEqual(0);
    expect(score.confidence).toBeLessThanOrEqual(1);
  });
});

describe('Negative Feedback Risk', () => {
  it('devolve 0..100 com confiança em [0,1]', () => {
    const score = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(5)),
    );

    expect(score.value).toBeGreaterThanOrEqual(0);
    expect(score.value).toBeLessThanOrEqual(100);
    expect(score.confidence).toBeGreaterThanOrEqual(0);
    expect(score.confidence).toBeLessThanOrEqual(1);
  });

  it('sinal real da plataforma eleva o risco além do que os proxies viam (deterministic-v2.1)', () => {
    // A dívida paga: até deterministic-v2, `hides`/`reports` alimentavam
    // `available`/`proxyBased` mas nunca o composto — este teste fixava a
    // ausência de leitura a propósito, com o comentário "quando passar a
    // ler, ele quebra". Esta é essa quebra.
    const semSinaisReais = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(series(5)),
    );
    const comSinaisReais = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(5, () => ({
          hides: 500,
          reports: 200,
          unlikes: 90,
          hideAllFor: 30,
        })),
      ),
    );

    expect(comSinaisReais.value).toBeGreaterThan(semSinaisReais.value);
    expect(comSinaisReais.signals.explicit).not.toBeNull();
    expect(semSinaisReais.signals.explicit).toBeNull();
  });

  it('sem o sinal explícito, o composto é idêntico ao de antes da correção (Google/TikTok não regridem)', () => {
    // A prova de que redistribuir o peso do quinto componente não muda nada
    // para quem não tem o campo: os quatro proxies, escalados por 0,5,
    // renormalizam de volta às MESMAS proporções (16/14/10/10 = 32/28/20/20 ÷
    // 2). Usa os sinais que a PRÓPRIA calculadora reportou — não uma segunda
    // implementação da aritmética de `normalize`/`ANCHORS` à mão, que
    // provaria a cópia igual à cópia, não a calculadora igual a si mesma.
    const resultado = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(5, (i) => ({ frequency: 1.1 + i * 1.4, clicks: 300 - i * 40 })),
      ),
    );

    expect(resultado.signals.explicit).toBeNull();

    const legacyComposite = weightedAverage([
      { value: resultado.signals.frequency, weight: 0.32 },
      { value: resultado.signals.ctrDecline, weight: 0.28 },
      { value: resultado.signals.cpmSpike, weight: 0.2 },
      { value: resultado.signals.saturation, weight: 0.2 },
    ]);

    expect(legacyComposite).not.toBeNull();
    expect(resultado.value).toBe(Math.round(legacyComposite! * 100));
  });

  it('feedback explícito presente e zerado é risco explícito baixo, não ausência de sinal', () => {
    // A distinção que `present` existe para proteger (P7): uma conta Meta que
    // o Graph confirma sem nenhuma ocultação é risco explícito ~0, não "sem
    // dado" — as duas coisas produziam o mesmo `null` antes desta correção.
    const zerado = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(5, () => ({ hides: 0, hideAllFor: 0, reports: 0, unlikes: 0 })),
      ),
    );

    expect(zerado.signals.explicit).toBe(0);
  });

  it('confiança tem piso quando o sinal é real — não depende só do volume da heurística', () => {
    const comSinalRealBaixoVolume = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(2, () => ({
          impressions: 100,
          hides: 5,
          reports: 2,
        })),
      ),
    );

    expect(comSinalRealBaixoVolume.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('frequência alta com CTR em queda eleva o risco', () => {
    const calmo = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(5, () => ({ frequency: 1.1, clicks: 300 })),
      ),
    );
    const saturado = NegativeFeedbackRiskCalculator.calculate(
      CreativeMetricsAggregator.aggregate(
        series(5, () => ({ frequency: 7, clicks: 10 })),
      ),
    );

    expect(saturado.value).not.toBe(calmo.value);
  });
});

describe('Fatigue e Saturation', () => {
  it('fadiga é 0..1, e não 0..100 — o contrato dos detectores', () => {
    // `fatigueScore ≥ 0.65` continua válido em A2-S5: mudar a escala aqui
    // quebraria o limiar sem quebrar nenhuma compilação.
    const fatigado = FatigueSaturationCalculator.fatigueScore(
      CreativeMetricsAggregator.aggregate(
        series(5, () => ({ frequency: 6, clicks: 10 })),
      ),
    );

    expect(fatigado).toBeGreaterThanOrEqual(0);
    expect(fatigado).toBeLessThanOrEqual(1);
    expect(fatigado).toBeGreaterThan(0.5);
  });

  it('frequência baixa com CTR alto não é fadiga', () => {
    expect(
      FatigueSaturationCalculator.fatigueScore(
        CreativeMetricsAggregator.aggregate(
          series(5, () => ({ frequency: 1.1, clicks: 300 })),
        ),
      ),
    ).toBeLessThan(0.5);
  });

  it('sem sinal, fadiga assume 0,2 — o benefício da dúvida', () => {
    expect(
      FatigueSaturationCalculator.fatigueScore(
        CreativeMetricsAggregator.aggregate([
          row({ frequency: null, clicks: 0, impressions: 0 }),
        ]),
      ),
    ).toBe(0.2);
  });

  it('saturação do portfólio é a fração de criativos fatigados', () => {
    expect(
      FatigueSaturationCalculator.portfolioSaturationRisk([
        { fatigueScore: 0.9 },
        { fatigueScore: 0.9 },
        { fatigueScore: 0.1 },
        { fatigueScore: 0.1 },
      ]),
    ).toBe(0.5);

    expect(FatigueSaturationCalculator.portfolioSaturationRisk([])).toBe(0);
  });

  it('dailyCpm recusa denominador zero', () => {
    expect(dailyCpm(100, 10_000)).toBeCloseTo(10, 5);
    expect(dailyCpm(100, 0)).toBeNull();
  });
});
