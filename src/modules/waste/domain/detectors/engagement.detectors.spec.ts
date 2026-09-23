import { DEFAULT_DETECTOR_PROFILE } from '../detector-profile';
import { buildBaseline } from '../baseline';
import {
  creativeFatigueDetector,
  learningInstabilityDetector,
  lowCtrDetector,
  negativeFeedbackDetector,
} from './engagement.detectors';
import { budgetStarvationDetector } from './opportunity.detectors';
import { aggregate, daily, score } from '../test-support/aggregate.fixture';
import type { AdWindowAggregate, DetectionContext } from '../detection-context';

/**
 * Os quatro detectores que **não** dependem de conversão, mais a oportunidade —
 * cada um contra a sua fronteira.
 *
 * Três deles consomem componentes do `AdScore` na **escala nativa** (§12.2):
 * `fatigue` em 0..1, `negativeFeedbackRisk` e `learningStability` em 0..100. A
 * troca de escala é o erro silencioso possível aqui: comparar `0,65` contra um
 * valor 0..100 nunca dispara, e comparar `40` contra um valor 0..1 dispara
 * sempre. Cada teste fixa os dois lados do corte.
 */

function contextFor(
  ad: AdWindowAggregate,
  scoreView: ReturnType<typeof score>,
  peers: AdWindowAggregate[] = [],
): DetectionContext {
  return {
    ad,
    adSetPeers: peers,
    accountBaseline: buildBaseline([ad, ...peers]),
    score: scoreView,
    windowDays: 14,
    profile: DEFAULT_DETECTOR_PROFILE,
  };
}

const spender = (overrides = {}) =>
  aggregate({ daily: daily(14, { spend: 100, spendBase: 100 }), ...overrides });

describe('CREATIVE_FATIGUE — escala nativa 0..1', () => {
  it('não dispara logo abaixo do corte de 0,65', () => {
    const finding = creativeFatigueDetector.detect(
      contextFor(spender(), score({ fatigue: 0.64 })),
    );

    expect(finding).toBeNull();
  });

  it('dispara no corte, e o incorrido é gasto × fadiga × 0,5', () => {
    const finding = creativeFatigueDetector.detect(
      contextFor(spender(), score({ fatigue: 0.8 })),
    );

    expect(finding?.type).toBe('CREATIVE_FATIGUE');
    // 1400 × 0,8 × 0,5 = 560. Não é a verba inteira: um criativo fatigado
    // continua entregando, e o desperdício é a parte que a repetição não
    // converte.
    expect(finding?.incurred.valueBase).toBe(560);
    expect(finding?.evidence.observed.fatigueScore).toBe(0.8);
  });
});

describe('NEGATIVE_FEEDBACK — escala nativa 0..100', () => {
  it('não dispara abaixo de 60', () => {
    expect(
      negativeFeedbackDetector.detect(
        contextFor(spender(), score({ negativeFeedbackRisk: 59 })),
      ),
    ).toBeNull();
  });

  it('dispara acima do corte com fator 0,4', () => {
    const finding = negativeFeedbackDetector.detect(
      contextFor(spender(), score({ negativeFeedbackRisk: 75 })),
    );

    expect(finding?.type).toBe('NEGATIVE_FEEDBACK');
    expect(finding?.incurred.valueBase).toBe(560); // 1400 × 0,4
    expect(finding?.scopeLevel).toBe('AD');
  });
});

describe('LEARNING_INSTABILITY — corte por baixo', () => {
  it('estabilidade alta não é instabilidade', () => {
    // 0..100 com **maior = mais estável**: inverter a comparação faria o
    // detector marcar exatamente os anúncios que convergiram.
    expect(
      learningInstabilityDetector.detect(
        contextFor(spender(), score({ learningStability: 80 })),
      ),
    ).toBeNull();
  });

  it('dispara abaixo de 40, com o menor fator do catálogo', () => {
    const finding = learningInstabilityDetector.detect(
      contextFor(spender(), score({ learningStability: 20 })),
    );

    expect(finding?.type).toBe('LEARNING_INSTABILITY');
    // 0,25 é o menor fator do catálogo: parte do gasto de aprendizado é custo
    // legítimo de entrada, não desperdício.
    expect(finding?.incurred.valueBase).toBe(350);
  });

  it('não dispara abaixo do piso de gasto, mesmo instável', () => {
    const tiny = aggregate({
      daily: daily(14, { spend: 1, spendBase: 1 }),
    });

    expect(
      learningInstabilityDetector.detect(
        contextFor(tiny, score({ learningStability: 10 })),
      ),
    ).toBeNull();
  });
});

describe('LOW_CTR — comparação contra os pares', () => {
  const peersWithCtr = (ctrs: number[]) =>
    ctrs.map((ctr, index) =>
      aggregate({
        adId: `peer-${index}`,
        daily: daily(14, { impressions: 10_000, clicks: ctr * 100 }),
      }),
    );

  it('sem benchmark não dispara — não há contra o que comparar', () => {
    const ad = spender();

    expect(lowCtrDetector.detect(contextFor(ad, score(), []))).toBeNull();
  });

  it('dispara abaixo do p25 dos pares e declara AD_SET', () => {
    // O anúncio tem CTR 0,1%; os pares, entre 2% e 5%.
    const ad = aggregate({
      daily: daily(14, { impressions: 10_000, clicks: 10 }),
    });
    const peers = peersWithCtr([2, 3, 4, 5]);

    const finding = lowCtrDetector.detect(contextFor(ad, score(), peers));

    expect(finding?.type).toBe('LOW_CTR');
    expect(finding?.scopeLevel).toBe('AD_SET');
    expect(finding?.evidenceSufficiency).toBe('SUFFICIENT');
    // O incorrido é a **distância para a mediana**, não o gasto todo: um CTR
    // ruim ainda entrega alguma coisa.
    expect(finding?.incurred.valueBase).toBeGreaterThan(0);
    expect(finding?.incurred.valueBase).toBeLessThan(ad.spendBase);
  });

  it('CTR igual à mediana dos pares não dispara', () => {
    const peers = peersWithCtr([3, 3, 3, 3]);
    const ad = aggregate({
      daily: daily(14, { impressions: 10_000, clicks: 300 }),
    });

    expect(lowCtrDetector.detect(contextFor(ad, score(), peers))).toBeNull();
  });

  /**
   * DEC-3 na direção certa — **o mesmo anúncio, os dois cortes.**
   *
   * `LOW_CTR` dispara **abaixo** do limiar, então ficar conservador é baixá-lo.
   * Multiplicar por 1,5 como se faz em `HIGH_CPA` deixaria o fallback 50% mais
   * **agressivo** — o oposto exato do que a decisão determinou, e um erro que
   * nenhum teste de "dispara/não dispara" isolado pegaria.
   */
  it('com < 3 pares o corte fica MAIS conservador, não menos', () => {
    // CTR 2,5% contra pares de 3,0%: fica abaixo do p25 nominal e acima do p25
    // rebaixado pelo fallback.
    const ad = aggregate({
      adId: 'alvo',
      daily: daily(14, { impressions: 10_000, clicks: 250 }),
    });
    const peers = peersWithCtr([3, 3, 3]);

    // Caminho nominal — três pares no conjunto: dispara.
    expect(lowCtrDetector.detect(contextFor(ad, score(), peers))?.type).toBe(
      'LOW_CTR',
    );

    // Mesmo anúncio, um par só: cai para a conta e o corte desce. Não dispara.
    const degraded = contextFor(ad, score(), peers.slice(0, 1));
    degraded.accountBaseline = buildBaseline([ad, ...peers]);

    expect(lowCtrDetector.detect(degraded)).toBeNull();
  });
});

describe('BUDGET_STARVATION — a oportunidade', () => {
  const peers = () =>
    ['p1', 'p2', 'p3'].map((id) =>
      aggregate({ adId: id, daily: daily(14, { impressions: 5_000 }) }),
    );

  it('não dispara sem score', () => {
    const ad = aggregate({ daily: daily(14, { impressions: 10 }) });

    expect(
      budgetStarvationDetector.detect({
        ...contextFor(ad, score({}, 90), peers()),
        score: null,
      }),
    ).toBeNull();
  });

  it('não dispara com score abaixo do piso alto', () => {
    // A recomendação derivada é a única que **aumenta** gasto: o piso é alto de
    // propósito.
    const ad = aggregate({ daily: daily(14, { impressions: 10 }) });

    expect(
      budgetStarvationDetector.detect(contextFor(ad, score({}, 50), peers())),
    ).toBeNull();
  });

  it('não dispara com menos de 3 pares — cala-se em vez de degradar', () => {
    const ad = aggregate({ daily: daily(14, { impressions: 10 }) });

    expect(
      budgetStarvationDetector.detect(
        contextFor(ad, score({}, 90), peers().slice(0, 2)),
      ),
    ).toBeNull();
  });

  it('não dispara quando o anúncio não está entregando', () => {
    const paused = aggregate({
      isDelivering: false,
      daily: daily(14, { impressions: 10 }),
    });

    expect(
      budgetStarvationDetector.detect(
        contextFor(paused, score({}, 90), peers()),
      ),
    ).toBeNull();
  });

  it('anúncio bem entregue não é sufocado', () => {
    const healthy = aggregate({ daily: daily(14, { impressions: 5_000 }) });

    expect(
      budgetStarvationDetector.detect(
        contextFor(healthy, score({}, 90), peers()),
      ),
    ).toBeNull();
  });
});
