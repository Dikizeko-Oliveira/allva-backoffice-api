import { DEFAULT_DETECTOR_PROFILE } from '../detector-profile';
import { buildBaseline } from '../baseline';
import {
  FINDING_KIND,
  FINDING_TYPES,
  scopeOf,
} from '../contracts/finding-catalog';
import {
  AD_SCOPED_DETECTORS,
  AD_SET_SCOPED_DETECTORS,
  ALL_DETECTORS,
  runAdDetector,
} from './index';
import { aggregate, daily, score } from '../test-support/aggregate.fixture';
import type { AdWindowAggregate, DetectionContext } from '../detection-context';

const GATE = { maturityGatingEnabled: true };

function contextFor(
  ad: AdWindowAggregate,
  peers: AdWindowAggregate[] = [],
  scoreView = score({
    fatigue: 0.9,
    negativeFeedbackRisk: 90,
    learningStability: 10,
  }),
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

/**
 * **O gate mais importante do catálogo, e ele é genérico de propósito.**
 *
 * P7: *"todo detector declara `minimumEvidence`; abaixo dela devolve `null` e a
 * insuficiência é reportada"*. O teste percorre o **registro**, não uma lista
 * escrita à mão: um detector novo entra automaticamente, e um que esqueça de
 * declarar limiar no perfil quebra aqui em vez de disparar sobre nada.
 */
describe('evidência mínima (P7)', () => {
  it('todo detector tem limiar declarado no perfil padrão', () => {
    for (const type of FINDING_TYPES) {
      expect(DEFAULT_DETECTOR_PROFILE.thresholds[type]).toBeDefined();
      expect(
        DEFAULT_DETECTOR_PROFILE.thresholds[type].minimumEvidence.days,
      ).toBeGreaterThan(0);
    }
  });

  it('o registro cobre os dez tipos, sem sobra nem falta', () => {
    expect(ALL_DETECTORS.map((detector) => detector.type).sort()).toEqual(
      [...FINDING_TYPES].sort(),
    );
  });

  it('a família de cada detector casa com o catálogo público', () => {
    for (const detector of ALL_DETECTORS) {
      expect(detector.scope).toBe(scopeOf(detector.type));
    }
  });

  it('nenhum detector de anúncio dispara com série abaixo do mínimo', () => {
    // Um dia de série, com números escandalosos em toda direção: gasto alto,
    // zero conversão, CTR no chão, componentes no pior valor possível. Se algum
    // detector disparar aqui, ele está afirmando sobre um dia de observação.
    const ad = aggregate({
      daily: daily(1, { spend: 5_000, spendBase: 5_000, clicks: 0 }),
    });

    for (const detector of AD_SCOPED_DETECTORS) {
      const result = runAdDetector(detector, contextFor(ad), GATE);

      expect({ type: detector.type, finding: result.finding }).toEqual({
        type: detector.type,
        finding: null,
      });
      expect(result.insufficiency?.reason).toContain('dia(s)');
    }
  });

  it('a insuficiência é reportada, nunca convertida em ausência de problema', () => {
    const ad = aggregate({ daily: daily(1) });
    const result = runAdDetector(AD_SCOPED_DETECTORS[0], contextFor(ad), GATE);

    // O contrato inteiro em uma asserção: sem achado **e** com motivo. Um `null`
    // mudo aqui faria a tela ler "não temos como olhar" como "está tudo bem".
    expect(result.insufficiency).toMatchObject({
      type: 'ZERO_CONVERSIONS',
      sufficiency: 'INSUFFICIENT',
    });
  });

  it('detector que depende de componente não dispara sem score', () => {
    const ad = aggregate({ daily: daily(14, { spendBase: 100, spend: 100 }) });

    for (const detector of AD_SCOPED_DETECTORS.filter((candidate) =>
      [
        'CREATIVE_FATIGUE',
        'NEGATIVE_FEEDBACK',
        'LEARNING_INSTABILITY',
      ].includes(candidate.type),
    )) {
      const result = runAdDetector(
        detector,
        { ...contextFor(ad), score: null },
        GATE,
      );

      expect(result.finding).toBeNull();
      expect(result.insufficiency?.sufficiency).toBe('MISSING_SCORE');
    }
  });

  it('componente indisponível na plataforma é insuficiência, não fadiga', () => {
    // §12.4: componente indisponível ⇒ o detector devolve `null`. Um anúncio de
    // Search não tem frequência, e o fallback da calculadora **não** é evidência.
    const ad = aggregate({ daily: daily(14, { spendBase: 100, spend: 100 }) });
    const withoutFatigue = score({ negativeFeedbackRisk: 90 });

    const result = runAdDetector(
      AD_SCOPED_DETECTORS.find(
        (detector) => detector.type === 'CREATIVE_FATIGUE',
      )!,
      contextFor(ad, [], withoutFatigue),
      GATE,
    );

    expect(result.finding).toBeNull();
    expect(result.insufficiency?.reason).toContain('fatigue');
  });
});

/**
 * §8.9 — os três detectores de conversão só disparam sobre janela `MATURE`.
 *
 * `ZERO_CONVERSIONS` origina `PAUSE_UNDERPERFORMING_AD`, a ação mais destrutiva
 * do catálogo: disparar sobre dado imaturo é recomendar pausar um anúncio que
 * converteu, e o usuário descobre isso na plataforma.
 */
describe('maturidade (§8.9)', () => {
  const spender = () =>
    aggregate({
      daily: daily(14, { spend: 100, spendBase: 100 }),
      dataMaturity: 'SETTLING',
    });

  it('ZERO_CONVERSIONS não dispara sobre janela SETTLING', () => {
    const result = runAdDetector(
      AD_SCOPED_DETECTORS[0],
      contextFor(spender()),
      GATE,
    );

    expect(result.finding).toBeNull();
    expect(result.insufficiency?.reason).toContain('MATURE');
  });

  it('dispara sobre a mesma janela quando ela amadurece', () => {
    const mature = aggregate({
      daily: daily(14, { spend: 100, spendBase: 100 }),
      dataMaturity: 'MATURE',
    });

    const result = runAdDetector(
      AD_SCOPED_DETECTORS[0],
      contextFor(mature),
      GATE,
    );

    expect(result.finding?.type).toBe('ZERO_CONVERSIONS');
  });

  it('com a flag desligada o corte de maturidade some — e só ele', () => {
    const result = runAdDetector(
      AD_SCOPED_DETECTORS[0],
      contextFor(spender()),
      {
        maturityGatingEnabled: false,
      },
    );

    expect(result.finding?.type).toBe('ZERO_CONVERSIONS');
  });
});

/** DEC-3 — a queda para linha de base da conta, declarada. */
describe('HIGH_CPA e a queda de benchmark (DEC-3)', () => {
  const highCpa = AD_SCOPED_DETECTORS.find(
    (detector) => detector.type === 'HIGH_CPA',
  )!;

  const converting = (id: string, conversions: number, spendBase: number) =>
    aggregate({
      adId: id,
      daily: daily(14, {
        spend: spendBase / 14,
        spendBase: spendBase / 14,
        conversions: conversions / 14,
      }),
    });

  it('com ≥ 3 pares compara contra a mediana do conjunto e declara AD_SET', () => {
    const ad = converting('ad-caro', 3, 3_000);
    const peers = [
      converting('p1', 30, 3_000),
      converting('p2', 30, 3_000),
      converting('p3', 30, 3_000),
    ];

    const result = runAdDetector(highCpa, contextFor(ad, peers), GATE);

    expect(result.finding?.scopeLevel).toBe('AD_SET');
    expect(result.finding?.evidenceSufficiency).toBe('SUFFICIENT');
    expect(result.finding?.evidence.benchmark?.kind).toBe('AD_SET_PEERS');
  });

  it('com < 3 pares cai para a conta, com PARTIAL e limiar 1,5× o nominal', () => {
    const ad = converting('ad-caro', 3, 3_000);
    const peer = converting('p1', 30, 3_000);

    // A conta tem os três anúncios necessários para uma linha de base, mas o
    // conjunto tem só um par: é exatamente a segunda linha da tabela de §10.3.
    const ctx = contextFor(ad, [peer]);
    ctx.accountBaseline = buildBaseline([
      ad,
      peer,
      converting('p2', 30, 3_000),
      converting('p3', 30, 3_000),
    ]);

    const result = runAdDetector(highCpa, ctx, GATE);

    expect(result.finding?.scopeLevel).toBe('AD_ACCOUNT');
    expect(result.finding?.evidenceSufficiency).toBe('PARTIAL');
    // 2× nominal × 1,5 de fallback = 3× a mediana da conta, que é o que §10.5
    // escreve como regra separada. Uma regra só, com o fallback explícito.
    const median = result.finding?.evidence.benchmark?.median ?? 0;
    expect(result.finding?.evidence.thresholds.maxCpa).toBeCloseTo(median * 3);
  });

  it('conta com menos de 3 anúncios não dispara', () => {
    const ad = converting('ad-caro', 3, 3_000);
    const ctx = contextFor(ad, []);
    ctx.accountBaseline = buildBaseline([ad, converting('p1', 30, 3_000)]);

    expect(runAdDetector(highCpa, ctx, GATE).finding).toBeNull();
  });

  it('a evidência degradada rebaixa a prioridade, nunca deixa CRITICAL', () => {
    const ad = converting('ad-caro', 3, 30_000);
    const peer = converting('p1', 300, 3_000);
    const ctx = contextFor(ad, [peer]);
    ctx.accountBaseline = buildBaseline([
      ad,
      peer,
      converting('p2', 300, 3_000),
      converting('p3', 300, 3_000),
    ]);

    const result = runAdDetector(highCpa, ctx, GATE);

    expect(result.finding?.evidenceSufficiency).toBe('PARTIAL');
    expect(result.finding?.priority).not.toBe('CRITICAL');
  });
});

/** DEC-4 e DEC-5 — a família de conjunto. */
describe('detectores de conjunto', () => {
  const [saturation, overlapping] = AD_SET_SCOPED_DETECTORS;

  it('AUDIENCE_SATURATION exige frequência subindo, não só frequência alta', () => {
    // Frequência constante em 5,0 e impressões estáveis: um público pequeno
    // sempre teve frequência alta, e isso não é saturação.
    const flat = aggregate({
      daily: daily(10, { frequency: 5, spend: 50, spendBase: 50 }),
    });

    const ctx = {
      adSetId: 'set-1',
      ads: [flat],
      scores: new Map([['ad-1', score()]]),
      accountBaseline: buildBaseline([flat]),
      windowDays: 14,
      profile: DEFAULT_DETECTOR_PROFILE,
    };

    expect(saturation.detect(ctx)).toEqual([]);
  });

  it('dispara com frequência crescente e impressões estáveis', () => {
    const rising = aggregate({
      daily: daily(10).map((point, index) => ({
        ...point,
        frequency: 3 + index * 0.3,
        spend: 50,
        spendBase: 50,
        impressions: 1_000,
      })),
    });

    const findings = saturation.detect({
      adSetId: 'set-1',
      ads: [rising],
      scores: new Map([['ad-1', score()]]),
      accountBaseline: buildBaseline([rising]),
      windowDays: 14,
      profile: DEFAULT_DETECTOR_PROFILE,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].scopeLevel).toBe('AD_SET');
    expect(findings[0].evidence.attributionRule).toContain('LOWEST_AI_SCORE');
  });

  it('OVERLAPPING_DELIVERY exige conteúdo idêntico, não só dois anúncios', () => {
    const a = aggregate({
      adId: 'a',
      contentHash: 'hash-a',
      daily: daily(14, { spend: 10, spendBase: 10 }),
    });
    const b = aggregate({
      adId: 'b',
      contentHash: 'hash-b',
      daily: daily(14, { spend: 10, spendBase: 10 }),
    });

    const ctx = {
      adSetId: 'set-1',
      ads: [a, b],
      scores: new Map([
        ['a', score({}, 20)],
        ['b', score({}, 80)],
      ]),
      accountBaseline: buildBaseline([a, b]),
      windowDays: 14,
      profile: DEFAULT_DETECTOR_PROFILE,
    };

    expect(overlapping.detect(ctx)).toEqual([]);

    const sameContent = { ...ctx, ads: [a, { ...b, contentHash: 'hash-a' }] };
    const findings = overlapping.detect(sameContent);

    expect(findings).toHaveLength(1);
    // Atribuição determinística: o pior `aiScore` recebe o achado, e o outro
    // consta em `relatedAdIds`. Sem determinismo, o fingerprint muda entre
    // execuções e a deduplicação quebra em silêncio.
    expect(findings[0].adId).toBe('a');
    expect(findings[0].evidence.relatedAdIds).toEqual(['b']);
  });
});

describe('oportunidade não é desperdício (§10.2)', () => {
  it('BUDGET_STARVATION nasce OPPORTUNITY e com incorrido zero', () => {
    const starved = aggregate({
      adId: 'ad-1',
      daily: daily(14, { impressions: 10, spend: 5, spendBase: 5 }),
    });
    const peers = ['p1', 'p2', 'p3'].map((id) =>
      aggregate({ adId: id, daily: daily(14, { impressions: 5_000 }) }),
    );

    const result = runAdDetector(
      AD_SCOPED_DETECTORS.find(
        (detector) => detector.type === 'BUDGET_STARVATION',
      )!,
      contextFor(starved, peers, score({}, 90)),
      GATE,
    );

    expect(result.finding?.kind).toBe('OPPORTUNITY');
    expect(FINDING_KIND.BUDGET_STARVATION).toBe('OPPORTUNITY');
    // "— (não é gasto)" na tabela de §10.5: não há dinheiro queimado a
    // contabilizar, há ganho que não aconteceu.
    expect(result.finding?.incurred).toEqual({ value: 0, valueBase: 0 });
    expect(result.finding?.avoidableDaily.valueBase).toBeGreaterThan(0);
  });
});

describe('as duas grandezas (§10.1)', () => {
  it('anúncio parado tem incorrido, mas evitável zero', () => {
    // O dinheiro saiu — o incorrido é fato. Mas não há nada a interromper
    // amanhã, e reportar evitável sobre ele encheria a ordenação padrão de
    // anúncios que já estão parados.
    const paused = aggregate({
      isDelivering: false,
      daily: daily(14, { spend: 100, spendBase: 100 }),
    });

    const result = runAdDetector(
      AD_SCOPED_DETECTORS[0],
      contextFor(paused),
      GATE,
    );

    expect(result.finding?.incurred.valueBase).toBeGreaterThan(0);
    expect(result.finding?.avoidableDaily).toEqual({ value: 0, valueBase: 0 });
  });

  it('as duas moedas saem do mesmo fator, sem conversão de câmbio', () => {
    const ad = aggregate({
      currency: 'USD',
      baseCurrency: 'BRL',
      daily: daily(14, { spend: 20, spendBase: 100 }),
    });

    const result = runAdDetector(AD_SCOPED_DETECTORS[0], contextFor(ad), GATE);

    // Fator 1 sobre as duas séries: 280 USD e 1400 BRL. O detector nunca tocou
    // em `fx_rates` — só `currency` pode (§16.10).
    expect(result.finding?.incurred).toEqual({ value: 280, valueBase: 1_400 });
  });
});
