import {
  COMPONENT_WEIGHTS,
  NEUTRAL_PRIOR,
  PRIOR_WEIGHT,
  type ComponentInput,
  type ScoreComponentName,
  composeAiScore,
  normalizeComponent,
} from './composition';
import { computeCoverage, platformCoverageMaxFor } from './coverage';

/**
 * §12.3 — composição com prior neutro, e §12.2 — as três grandezas de cobertura.
 *
 * Dois gates de A2-S4 vivem aqui: "testes do composto e da normalização nas
 * fronteiras" e "anúncio estático no Google entra na ordenação de `GET /ads`
 * (DEC-2 verificada)".
 */

function component(overrides: Partial<ComponentInput> = {}): ComponentInput {
  return { value: 50, confidence: 1, available: true, ...overrides };
}

const ALL: Record<ScoreComponentName, ComponentInput> = {
  attention: component(),
  audienceFit: component(),
  learningStability: component(),
  negativeFeedbackRisk: component(),
  fatigue: component({ value: 0.5 }),
};

describe('normalização versionada (§12.1)', () => {
  it('escala 0..100 direta passa sem mexer', () => {
    expect(normalizeComponent('attention', 0)).toBe(0);
    expect(normalizeComponent('attention', 50)).toBe(50);
    expect(normalizeComponent('attention', 100)).toBe(100);
  });

  it('componente invertido vira "maior é melhor"', () => {
    // Risco de feedback negativo alto é score baixo: o composto só sabe somar
    // numa direção, e é a normalização que resolve isso — não cada calculadora.
    expect(normalizeComponent('negativeFeedbackRisk', 0)).toBe(100);
    expect(normalizeComponent('negativeFeedbackRisk', 100)).toBe(0);
  });

  it('fadiga é 0..1 nativa e também inverte', () => {
    // A única com escala nativa diferente — e a razão de a escala ser declarada
    // por componente em vez de uma constante global.
    expect(normalizeComponent('fatigue', 0)).toBe(100);
    expect(normalizeComponent('fatigue', 1)).toBe(0);
    expect(normalizeComponent('fatigue', 0.65)).toBeCloseTo(35, 5);
  });

  it('satura nas pontas em vez de extrapolar', () => {
    // Valor fora da faixa é defeito da calculadora; extrapolar o esconderia
    // produzindo um score acima de 100 que a UI renderiza sem reclamar.
    expect(normalizeComponent('attention', 150)).toBe(100);
    expect(normalizeComponent('attention', -50)).toBe(0);
    expect(normalizeComponent('fatigue', 3)).toBe(0);
  });

  it('ausência e não-finito devolvem null, nunca zero', () => {
    expect(normalizeComponent('attention', null)).toBeNull();
    expect(normalizeComponent('attention', Number.NaN)).toBeNull();
    expect(
      normalizeComponent('attention', Number.POSITIVE_INFINITY),
    ).toBeNull();
  });
});

describe('composição com prior neutro (§12.3)', () => {
  it('os pesos de §12.1 somam 1,0', () => {
    const total = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('tudo neutro com confiança plena continua neutro', () => {
    expect(composeAiScore(ALL).aiScore).toBeCloseTo(50, 5);
  });

  it('evidência plena leva o score ao valor dos componentes', () => {
    const excelente = composeAiScore({
      attention: component({ value: 100 }),
      audienceFit: component({ value: 100 }),
      learningStability: component({ value: 100 }),
      negativeFeedbackRisk: component({ value: 0 }),
      fatigue: component({ value: 0 }),
    });

    // Não chega a 100: o prior continua no denominador e puxa para o meio, o
    // que é correto — nem a melhor evidência disponível é certeza.
    expect(excelente.aiScore).toBeGreaterThan(70);
    expect(excelente.aiScore).toBeLessThan(100);
    expect(excelente.aiConfidence).toBeCloseTo(1, 5);
  });

  it('**o prior é o que impede evidência fraca de virar afirmação forte**', () => {
    // O cenário de §12.3: anúncio de 3 dias cuja única componente mensurável é
    // fadiga. Sem o prior, ele receberia o valor da fadiga como AI Score — tão
    // assertivo quanto o de um anúncio com 30 dias e cinco componentes, apenas
    // com um rótulo de confiança baixa ao lado que ninguém lê.
    const soFadiga = composeAiScore({
      fatigue: component({ value: 0 }), // fadiga zero ⇒ normalizado 100
    });

    expect(soFadiga.aiScore).toBeLessThan(60);
    expect(soFadiga.aiScore).toBeGreaterThan(50);
    expect(soFadiga.aiConfidence).toBeCloseTo(0.15, 4);
  });

  it('sem componente nenhum, o score é exatamente o prior', () => {
    const vazio = composeAiScore({});

    expect(vazio.aiScore).toBe(NEUTRAL_PRIOR);
    expect(vazio.aiConfidence).toBe(0);
    expect(vazio.componentCoverage).toBe(0);
    expect(vazio.componentsAvailable).toEqual([]);
    expect(vazio.componentsUnavailable).toHaveLength(5);
  });

  it('confiança divide por TODOS os pesos, não só pelos disponíveis', () => {
    // Dividir só pelos disponíveis faria um anúncio com um único componente
    // perfeito marcar confiança 1,0 — e a confiança deixaria de medir ignorância.
    const umSo = composeAiScore({ audienceFit: component({ confidence: 1 }) });

    expect(umSo.aiConfidence).toBeCloseTo(COMPONENT_WEIGHTS.audienceFit, 4);
    expect(umSo.aiConfidence).toBeLessThan(1);
  });

  it('componente indisponível não é o mesmo que componente ruim', () => {
    const indisponivel = composeAiScore({
      ...ALL,
      attention: component({ available: false, value: 0 }),
    });
    const ruim = composeAiScore({ ...ALL, attention: component({ value: 0 }) });

    // O indisponível some da conta (e derruba a confiança); o ruim entra e
    // derruba o score. Tratá-los igual é como uma plataforma sem vídeo passaria
    // a parecer ruim em vez de não medida.
    expect(indisponivel.aiScore).toBeGreaterThan(ruim.aiScore);
    expect(indisponivel.componentsUnavailable).toContain('attention');
    expect(indisponivel.aiConfidence).toBeLessThan(ruim.aiConfidence);
  });

  it('valor nulo com `available: true` também sai da conta', () => {
    // "A plataforma mede, mas nesta janela não veio" — o efeito no composto é o
    // mesmo, e a distinção sobrevive no motivo que a cobertura declara.
    const semValor = composeAiScore({
      ...ALL,
      fatigue: component({ value: null }),
    });

    expect(semValor.componentsUnavailable).toContain('fatigue');
  });

  it('confiança baixa aproxima o score do neutro sem zerar o componente', () => {
    const confiante = composeAiScore({
      audienceFit: component({ value: 100, confidence: 1 }),
    });
    const inseguro = composeAiScore({
      audienceFit: component({ value: 100, confidence: 0.1 }),
    });

    expect(confiante.aiScore).toBeGreaterThan(inseguro.aiScore);
    expect(inseguro.aiScore).toBeGreaterThan(NEUTRAL_PRIOR);
  });

  it('confiança fora de [0,1] é contida, não propagada', () => {
    const absurdo = composeAiScore({
      audienceFit: component({ value: 100, confidence: 99 }),
    });

    expect(absurdo.aiConfidence).toBeLessThanOrEqual(1);
    expect(absurdo.aiScore).toBeLessThanOrEqual(100);
  });

  it('o peso do prior é versionável', () => {
    const forte = composeAiScore(
      { audienceFit: component({ value: 100 }) },
      PRIOR_WEIGHT * 10,
    );
    const fraco = composeAiScore(
      { audienceFit: component({ value: 100 }) },
      0.1,
    );

    expect(forte.aiScore).toBeLessThan(fraco.aiScore);
  });
});

describe('as três grandezas de cobertura (DEC-2)', () => {
  it('Meta mede tudo: teto de cobertura 1,0', () => {
    expect(platformCoverageMaxFor('META')).toBe(1);
  });

  it('Google mede vídeo pelo quartil de visualização, mas não feedback negativo nem frequência', () => {
    // 1 − 0,15 (negativeFeedbackRisk) − 0,15 (fatigue) = 0,70. `attention`
    // entrou quando o provider passou a ler o quartil de vídeo (análise de
    // hooks) — o Google mede pelo menos um anúncio de vídeo, então a
    // plataforma mede vídeo, mesmo que o Search dentro dela não.
    expect(platformCoverageMaxFor('GOOGLE')).toBeCloseTo(0.7, 4);
  });

  it('**anúncio de Search no Google entra na ordenação** — o gate de DEC-2', () => {
    // `hasVideoFormat: false` é o que um anúncio de Search declara: o Google
    // mede vídeo (teto pleno 0,70), mas Search não é vídeo — o teto **deste
    // anúncio** desconta `attention` pela mesma razão que já descontava
    // `negativeFeedbackRisk` e `fatigue`. Com piso ABSOLUTO de 0,60 sobre
    // `componentCoverage`, este anúncio marcaria 0,45 e sumiria de toda
    // ordenação e de todo alerta. Com `coverageRatio`, ele marca 1,0: é o
    // melhor que o formato permite, e entra.
    const google = computeCoverage({
      platform: 'GOOGLE',
      componentsAvailable: ['audienceFit', 'learningStability'],
      hasVideoFormat: false,
    });

    expect(google.componentCoverage).toBeCloseTo(0.45, 4);
    expect(google.platformCoverageMax).toBeCloseTo(0.45, 4);
    expect(google.coverageRatio).toBe(1);
    expect(google.coverageRatio).toBeGreaterThanOrEqual(0.6);
  });

  /**
   * O defeito que a mesma pergunta, sem `hasVideoFormat`, cometia: um anúncio
   * de Search pagando o peso de `attention` (0,25) que o formato nunca produz,
   * derrubando `coverageRatio` para 0,64 — abaixo do que o Search algum dia
   * poderia alcançar mesmo com todo o resto medido.
   */
  it('sem hasVideoFormat, o mesmo anúncio de Search paga o peso de vídeo que não pode gerar', () => {
    const semFormato = computeCoverage({
      platform: 'GOOGLE',
      componentsAvailable: ['audienceFit', 'learningStability'],
    });

    expect(semFormato.platformCoverageMax).toBeCloseTo(0.7, 4);
    expect(semFormato.coverageRatio).toBeLessThan(1);
  });

  it('o mesmo anúncio sem audienceFit cai e sai — que é o correto', () => {
    const semFit = computeCoverage({
      platform: 'GOOGLE',
      componentsAvailable: ['learningStability'],
      hasVideoFormat: false,
    });

    expect(semFit.coverageRatio).toBeLessThan(0.6);
  });

  it('declara POR QUE cada componente ausente não foi medido (P7)', () => {
    const google = computeCoverage({
      platform: 'GOOGLE',
      componentsAvailable: ['audienceFit', 'learningStability'],
      hasVideoFormat: false,
    });

    // Terceiro motivo: a plataforma mede o sinal, só não neste anúncio —
    // formato sem vídeo, não falta de dado nem limite da plataforma.
    expect(google.unavailableReasons.attention).toContain('vídeo');
    expect(google.unavailableReasons.negativeFeedbackRisk).toContain('Google');
    expect(google.unavailableReasons.fatigue).toContain('Search');
  });

  it('anúncio estático da Meta não paga o peso de vídeo que não pode produzir (§12.4, dívida B7-bis)', () => {
    // Sem `hasVideoFormat`, o teto pleno da Meta é 1,0 — mas uma imagem nunca
    // gera thumbstopRate/holdRate, e cobrar o peso de `attention` (0,25) do
    // piso de escala (0,80) a deixaria fora de ESCALAR para sempre.
    const staticMeta = computeCoverage({
      platform: 'META',
      componentsAvailable: [
        'audienceFit',
        'learningStability',
        'negativeFeedbackRisk',
        'fatigue',
      ],
      hasVideoFormat: false,
    });

    expect(staticMeta.platformCoverageMax).toBeCloseTo(0.75, 4);
    expect(staticMeta.coverageRatio).toBe(1);
  });

  it('componente que a plataforma mede mas faltou na janela tem motivo próprio', () => {
    const meta = computeCoverage({
      platform: 'META',
      componentsAvailable: ['audienceFit'],
    });

    expect(meta.unavailableReasons.attention).toContain(
      'Sem dados suficientes',
    );
  });

  it('coverageRatio nunca passa de 1', () => {
    const meta = computeCoverage({
      platform: 'META',
      componentsAvailable: [
        'attention',
        'audienceFit',
        'learningStability',
        'negativeFeedbackRisk',
        'fatigue',
      ],
    });

    expect(meta.coverageRatio).toBe(1);
  });
});
