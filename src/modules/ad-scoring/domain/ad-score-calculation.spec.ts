import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { calculateAdScore } from './ad-score-calculation';
import {
  computeInputDigest,
  optimizationKeyOf,
  usableForIntelligence,
} from './score-input';
import {
  conversionTarget,
  nonConversionTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * O cálculo completo de um `AdScore`, ponta a ponta e sem I/O.
 *
 * Dois gates de A2-S4 vivem aqui:
 *
 * - **P4** — "com todos os providers de IA desligados, score continua sendo
 *   produzido". O cálculo é determinístico e não conhece IA: nem por injeção,
 *   nem por import. O teste que prova isso é o de que ele roda sem nada além da
 *   série.
 * - **P9** — "sem mudança de `inputDigest`, zero chamada de LLM no dia
 *   seguinte". O digest é uma função dos números que mudam o score, e o teste
 *   fixa o que entra e o que **não** entra nele.
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

const BASE = {
  algoVersion: 'deterministic-v2',
  priorWeight: 1,
  windowDays: 14,
};

describe('cálculo do AdScore', () => {
  it('**P4: produz score sem nenhum provider de IA** — o gate do sprint', () => {
    // O cálculo não recebe cliente de IA por injeção nem o importa. Com todos os
    // providers desligados, o produto continua inteiro: a narrativa some, o
    // número fica.
    const score = calculateAdScore({
      platform: 'META',
      rows: series(14),
      ...BASE,
    });

    expect(score.aiScore).toBeGreaterThan(0);
    expect(score.aiScore).toBeLessThanOrEqual(100);
    expect(score.aiConfidence).toBeGreaterThan(0);
  });

  it('**criativo novo não é punido — é declarado desconhecido**', () => {
    // O contrato que a calculadora de `Attention` tentava (e falhava) garantir
    // com um fallback interno. Ele vive aqui, na composição, e funciona: um
    // anúncio de um dia com 600 impressões e nenhum clique pontua o **prior
    // neutro** com confiança zero, em vez de herdar o CTR zero como veredito.
    const novo = calculateAdScore({
      platform: 'META',
      rows: [
        row({
          impressions: 600,
          clicks: 0,
          conversions: 0,
          revenue: 0,
          spend: 10,
          frequency: null,
          thumbstopRate: null,
          holdRate: null,
          engagement: null,
        }),
      ],
      ...BASE,
    });

    expect(novo.aiScore).toBe(50);
    expect(novo.aiConfidence).toBe(0);
    expect(novo.components.audienceFit.available).toBe(false);
  });

  it('**gasto sem clique não é evidência de fit** — ROAS zero não é fit zero', () => {
    // `roas` vale 0, e não `null`, assim que há qualquer gasto. Aceitar
    // `roas !== null` como sinal marcaria "fit medido = péssimo" em todo anúncio
    // que gastou dez reais e ainda não converteu — e o prior não salva esse
    // caso, porque um componente **disponível** com o pior valor entra no
    // composto com peso total.
    const semClique = calculateAdScore({
      platform: 'META',
      rows: series(7, () => ({ clicks: 0, conversions: 0, revenue: 0 })),
      ...BASE,
    });
    const comTrafegoSemConversao = calculateAdScore({
      platform: 'META',
      rows: series(7, () => ({ clicks: 200, conversions: 0, revenue: 0 })),
      ...BASE,
    });

    expect(semClique.components.audienceFit.available).toBe(false);
    // Com tráfego e nenhuma conversão, aí sim há o que medir: é fit ruim de
    // verdade, e o componente entra.
    expect(comTrafegoSemConversao.components.audienceFit.available).toBe(true);
  });

  it('série vazia devolve o prior, e não um erro', () => {
    const score = calculateAdScore({ platform: 'META', rows: [], ...BASE });

    expect(score.aiScore).toBe(50);
    expect(score.aiConfidence).toBe(0);
    expect(score.daysUsed).toBe(0);
  });

  it('linha sem taxa de câmbio fica fora e a exclusão é REPORTADA', () => {
    // Somá-la com `spendBase = 0` faria o gasto do período encolher em silêncio.
    const score = calculateAdScore({
      platform: 'META',
      rows: [
        ...series(5),
        row({
          date: new Date('2026-07-10T00:00:00Z'),
          normalizationPending: true,
        }),
      ],
      ...BASE,
    });

    expect(score.excludedByNormalization).toBe(1);
    expect(score.daysUsed).toBe(5);
  });

  it('**a descontinuidade corta a janela ANTES de calcular componente**', () => {
    // Se cortasse depois, os componentes misturariam duas réguas e o corte
    // deixaria de proteger o que existe para proteger (§15.2).
    const comCorte = calculateAdScore({
      platform: 'META',
      rows: series(10, (index) =>
        index === 7 ? { seriesDiscontinuity: 'NEW_SIGNAL' } : {},
      ),
      ...BASE,
    });

    expect(comCorte.seriesDiscontinuity).toBe('NEW_SIGNAL');
    expect(comCorte.droppedByDiscontinuity).toBe(7);
    expect(comCorte.daysUsed).toBe(3);
  });

  it('a chegada de sinal novo marca o dia mais recente, não a série inteira', () => {
    const score = calculateAdScore({
      platform: 'META',
      rows: series(10),
      newSignalArrived: true,
      ...BASE,
    });

    expect(score.seriesDiscontinuity).toBe('NEW_SIGNAL');
    // Cortar tudo seria o mesmo que não ter série; o dia do deploy é o primeiro
    // sob a régua nova e entra na janela.
    expect(score.daysUsed).toBe(1);
  });

  it('pausa longa corta a série sem ninguém precisar declarar', () => {
    const score = calculateAdScore({
      platform: 'META',
      rows: [
        ...series(3),
        row({ date: new Date('2026-07-25T00:00:00Z') }),
        row({ date: new Date('2026-07-26T00:00:00Z') }),
      ],
      ...BASE,
    });

    expect(score.seriesDiscontinuity).toBe('RESUMED_AFTER_PAUSE');
    expect(score.daysUsed).toBe(2);
  });

  it('componente sem sinal é declarado indisponível, com motivo (P7)', () => {
    const semVideo = calculateAdScore({
      platform: 'META',
      rows: series(7, () => ({ thumbstopRate: null, holdRate: null })),
      ...BASE,
    });

    expect(semVideo.components.attention.available).toBe(false);
    expect(semVideo.components.attention.unavailableReason).toBeTruthy();
    // O valor nativo é preservado: a tela mostra o que foi apurado, e o detector
    // de A2-S5 consome a escala nativa mesmo fora do composto.
    expect(semVideo.components.attention.value).not.toBeNull();
    expect(semVideo.components.attention.normalizedValue).toBeNull();
  });

  it('marca `proxyBased` enquanto os sinais reais de feedback não chegam (§12.2)', () => {
    const proxy = calculateAdScore({
      platform: 'META',
      rows: series(7),
      ...BASE,
    });
    const real = calculateAdScore({
      platform: 'META',
      rows: series(7, () => ({
        hides: 3,
        reports: 1,
        unlikes: 2,
        hideAllFor: 0,
      })),
      ...BASE,
    });

    // Não é confiança baixa: é **outra medida**, e a distinção é o que justifica
    // marcar descontinuidade no dia em que os sinais reais chegam.
    expect(proxy.components.negativeFeedbackRisk.proxyBased).toBe(true);
    expect(proxy.components.negativeFeedbackRisk.available).toBe(false);
    expect(real.components.negativeFeedbackRisk.proxyBased).toBe(false);
    expect(real.components.negativeFeedbackRisk.available).toBe(true);
  });

  it('`saturationRisk` fica no contexto e FORA do composto (§12.1)', () => {
    const score = calculateAdScore({
      platform: 'META',
      rows: series(7),
      ...BASE,
    });

    expect(score.context.saturationRisk).toMatchObject({
      scopeLevel: 'AD_SET',
    });
    expect(Object.keys(score.components)).not.toContain('saturationRisk');
  });

  it('Google entra com cobertura relativa cheia (DEC-2)', () => {
    const google = calculateAdScore({
      platform: 'GOOGLE',
      rows: series(7, () => ({
        thumbstopRate: null,
        holdRate: null,
        frequency: null,
      })),
      ...BASE,
    });

    expect(google.platformCoverageMax).toBeCloseTo(0.45, 4);
    expect(google.coverageRatio).toBe(1);
    // Passa o piso de §12.4 e entra na ordenação — que é a decisão inteira.
    expect(google.coverageRatio).toBeGreaterThanOrEqual(0.6);
  });
});

describe('inputDigest (P9)', () => {
  const rows = series(5);

  it('a mesma série produz o mesmo digest', () => {
    expect(computeInputDigest({ rows, ...BASE })).toBe(
      computeInputDigest({ rows: [...rows].reverse(), ...BASE }),
    );
  });

  it('mudança de métrica muda o digest', () => {
    const outro = computeInputDigest({
      rows: series(5, (index) => (index === 0 ? { clicks: 999 } : {})),
      ...BASE,
    });

    expect(outro).not.toBe(computeInputDigest({ rows, ...BASE }));
  });

  it('mudança de versão de algoritmo ou de prior muda o digest', () => {
    const base = computeInputDigest({ rows, ...BASE });

    expect(computeInputDigest({ rows, ...BASE, algoVersion: 'v3' })).not.toBe(
      base,
    );
    expect(computeInputDigest({ rows, ...BASE, priorWeight: 2 })).not.toBe(
      base,
    );
  });

  it('**`syncedAt` NÃO entra no digest**', () => {
    // Ele muda a cada ingest sem que nenhum número tenha mudado. Incluí-lo faria
    // o digest invalidar sempre, e P9 viraria cerimônia que não economiza nada.
    const outroSync = series(5, () => ({
      syncedAt: new Date('2027-01-01T00:00:00Z'),
    }));

    expect(computeInputDigest({ rows: outroSync, ...BASE })).toBe(
      computeInputDigest({ rows, ...BASE }),
    );
  });

  it('a chegada de um sinal antes ausente muda o digest', () => {
    // É o que faz o dia do deploy de `hides` recomputar — e só ele.
    const comSinais = series(5, () => ({ hides: 2, reports: 1 }));

    expect(computeInputDigest({ rows: comSinais, ...BASE })).not.toBe(
      computeInputDigest({ rows, ...BASE }),
    );
  });

  it('linha entrando ou saindo por câmbio muda o digest', () => {
    const pendente = series(5, (index) =>
      index === 0 ? { normalizationPending: true } : {},
    );

    expect(computeInputDigest({ rows: pendente, ...BASE })).not.toBe(
      computeInputDigest({ rows, ...BASE }),
    );
  });

  it('separa o que a inteligência pode ler do que não pode (M1)', () => {
    const { usable, excludedByNormalization } = usableForIntelligence([
      ...series(3),
      row({ normalizationPending: true }),
    ]);

    expect(usable).toHaveLength(3);
    expect(excludedByNormalization).toBe(1);
  });
});

describe('objetivo de otimização', () => {
  // Tráfego com cliques e nenhuma compra: antes, `audienceFit` se declarava
  // disponível com conversão zero e entrava como "fit péssimo" (peso 0,30).
  // Com sinal de feedback negativo presente, a única lacuna possível é a do
  // objetivo — é o que isola o efeito que o teste mede.
  const trafficSeries = series(14, () => ({
    conversions: 0,
    revenueBase: 0,
    revenue: 0,
    hides: 0,
    hideAllFor: 0,
    reports: 0,
    unlikes: 0,
  }));

  it('anúncio de tráfego não tem audienceFit — ele não buscou conversão', () => {
    const score = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: trafficSeries,
      optimization: nonConversionTarget('TRAFFIC'),
    });

    expect(score.components.audienceFit.available).toBe(false);
    expect(score.components.audienceFit.unavailableReason).toContain('tráfego');
  });

  it('o teto de cobertura deixa de cobrar o peso que o objetivo não gera', () => {
    const asTraffic = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: trafficSeries,
      optimization: nonConversionTarget('TRAFFIC'),
    });
    const asSales = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: trafficSeries,
      optimization: conversionTarget('PURCHASE'),
    });

    expect(asTraffic.platformCoverageMax).toBeLessThan(
      asSales.platformCoverageMax,
    );
    // Com o teto certo, o anúncio de tráfego não fica preso abaixo do piso de
    // cobertura por um componente que nunca teria.
    expect(asTraffic.coverageRatio).toBe(1);
  });

  it('o score do anúncio de tráfego não é puxado para baixo pela conversão zero', () => {
    const asTraffic = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: trafficSeries,
      optimization: nonConversionTarget('TRAFFIC'),
    });
    const judgedAsSales = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: trafficSeries,
      optimization: conversionTarget('PURCHASE'),
    });

    expect(asTraffic.aiScore).toBeGreaterThan(judgedAsSales.aiScore);
  });

  it('lead contável continua medindo audienceFit', () => {
    const score = calculateAdScore({
      ...BASE,
      platform: 'META',
      rows: series(14),
      optimization: conversionTarget('LEAD'),
    });
    expect(score.components.audienceFit.available).toBe(true);
  });

  it('a mudança de objetivo muda o digest, mesmo sem métrica nova', () => {
    const rows = series(14);
    const digest = (key: string) =>
      computeInputDigest({ ...BASE, rows, optimizationKey: key });

    expect(
      digest(optimizationKeyOf(nonConversionTarget('AWARENESS'))),
    ).not.toBe(digest(optimizationKeyOf(conversionTarget('PURCHASE'))));
  });
});
