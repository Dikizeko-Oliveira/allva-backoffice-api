import {
  conversionTarget,
  nonConversionTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { plan } from './recommendation-policy';
import { evaluateScaleGuards, SCALE_GUARDS } from './scale-guards';
import {
  ACTION_PLAN_BY_KIND,
  IMPACT_TYPE_BY_KIND,
  PRIMARY_IMPACT_BY_KIND,
  RECOMMENDATION_KINDS,
  kindForFinding,
} from '../contracts/recommendation-catalog';
import { FINDING_TYPES } from 'src/modules/waste/domain/contracts/finding-catalog';
import type {
  FindingSignal,
  PolicyThresholds,
  RecommendationSignals,
} from '../recommendation-plan';

const THRESHOLDS: PolicyThresholds = {
  scaleMinScore: 75,
  scaleMinConfidence: 0.7,
  scaleMinCoverageRatio: 0.8,
  scaleRoasMultiple: 2,
  scaleMaxFatigue: 0.5,
  saturationFrequency: 3.5,
  minLearningStability: 40,
  budgetReductionFactor: 0.3,
  scaleIncreaseFactor: 0.2,
  impactHorizonDays: 14,
  expiryDays: 7,
};

function finding(overrides: Partial<FindingSignal> = {}): FindingSignal {
  return {
    id: 'item-1',
    type: 'ZERO_CONVERSIONS',
    findingKind: 'WASTE',
    priority: 'CRITICAL',
    avoidableDailyBase: 100,
    avoidableDaily: 100,
    incurredBase: 1_400,
    evidenceSufficiency: 'SUFFICIENT',
    dataMaturity: 'MATURE',
    ...overrides,
  };
}

/** `ad` aceita override parcial: cada teste declara só a fronteira que exercita. */
function signals(
  overrides: Partial<Omit<RecommendationSignals, 'ad'>> & {
    ad?: Partial<RecommendationSignals['ad']>;
  } = {},
): RecommendationSignals {
  return {
    ad: {
      adId: 'ad-1',
      adSetId: 'set-1',
      campaignId: 'campaign-1',
      adAccountId: 'account-1',
      platform: 'META',
      creativeId: 'creative-1',
      creativeFormat: null,
      contentHash: 'hash-1',
      isDelivering: true,
      dataMaturity: 'MATURE',
      currency: 'BRL',
      baseCurrency: 'BRL',
      frequency: 2,
      optimization: conversionTarget('PURCHASE'),
      cpa: null,
      peerMedianCpa: null,
      roas: 4,
      peerMedianRoas: 1,
      adSetDailyBudget: 100,
      campaignDailyBudget: 500,
      ...overrides.ad,
    },
    findings: overrides.findings ?? [finding()],
    score: overrides.score ?? {
      aiScore: 85,
      aiConfidence: 0.9,
      coverageRatio: 1,
      fatigueScore: 0.1,
      learningStability: 80,
      audienceFit: 70,
      negativeFeedbackRisk: 10,
      delta7d: 2,
      scoredAt: new Date('2026-08-02T00:00:00.000Z'),
    },
    adSetFindingTypes: overrides.adSetFindingTypes ?? [],
    replacementCreativeId: overrides.replacementCreativeId ?? null,
    replacementRationale: null,
    selectedCopy: overrides.selectedCopy ?? null,
    thresholds: THRESHOLDS,
    now: new Date('2026-08-02T12:00:00.000Z'),
  };
}

describe('catálogo — nenhum tipo fica órfão', () => {
  it('todo achado mapeia para um kind existente', () => {
    for (const type of FINDING_TYPES) {
      expect(RECOMMENDATION_KINDS).toContain(kindForFinding(type));
    }
  });

  it('todo kind declara plano de ação, impacto e delta primário', () => {
    for (const kind of RECOMMENDATION_KINDS) {
      expect(ACTION_PLAN_BY_KIND[kind]).toBeDefined();
      expect(IMPACT_TYPE_BY_KIND[kind]).toBeDefined();
      expect(PRIMARY_IMPACT_BY_KIND[kind]).toBeDefined();
    }
  });

  it('só EXPAND_AUDIENCE nasce sem ação prevista', () => {
    const semAcao = RECOMMENDATION_KINDS.filter(
      (kind) => ACTION_PLAN_BY_KIND[kind].length === 0,
    );

    expect(semAcao).toEqual(['EXPAND_AUDIENCE']);
  });
});

describe('plano a partir de achados', () => {
  it('ZERO_CONVERSIONS vira PAUSE_UNDERPERFORMING_AD com ação no anúncio', () => {
    const [built] = plan(signals()).filter(
      (item) => item.kind === 'PAUSE_UNDERPERFORMING_AD',
    );

    expect(built.advisory).toBe(false);
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0]).toMatchObject({
      type: 'PAUSE_AD',
      targetEntityType: 'AD',
      targetEntityId: 'ad-1',
    });
    expect(built.wasteItemIds).toEqual(['item-1']);
  });

  it('o impacto estimado é o evitável projetado no horizonte (§9.7)', () => {
    const [built] = plan(signals());

    // 100/dia × 14 dias. A **mesma** fórmula que o outcome vai comparar depois:
    // duas fórmulas diferentes fariam P8 medir a diferença entre elas.
    expect(built.impacts[0]).toMatchObject({
      type: 'SAVINGS',
      estimatedBase: 1_400,
      horizonDays: 14,
    });
  });

  it('vários achados do mesmo kind viram UM plano, com o max do evitável', () => {
    const built = plan(
      signals({
        findings: [
          finding({
            id: 'a',
            type: 'ZERO_CONVERSIONS',
            avoidableDailyBase: 40,
          }),
          finding({ id: 'b', type: 'LOW_ROAS', avoidableDailyBase: 90 }),
        ],
      }),
    ).filter((item) => item.kind === 'PAUSE_UNDERPERFORMING_AD');

    expect(built).toHaveLength(1);
    // N:N: o plano responde aos dois sinais e resolvê-lo resolve os dois.
    expect(built[0].wasteItemIds).toEqual(['a', 'b']);
    // `max`, nunca soma — 130 contaria o mesmo gasto duas vezes (§10.6).
    expect(built[0].evidence.avoidableDailyBase).toBe(90);
  });

  /**
   * O laço que a geração de copy fecha.
   *
   * `REPLACE_CTA` nascia **sempre** consultiva, com a nota de que o parâmetro é
   * texto autoral e não tinha de onde vir. A variação escolhida no Copy Studio
   * passa a ser essa fonte — e a recusa não sumiu, virou condição.
   */
  it('REPLACE_CTA sem chamada escolhida continua consultiva', () => {
    const [built] = plan(
      signals({
        ad: { roas: 0.5, peerMedianRoas: 4 },
        selectedCopy: null,
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built.advisory).toBe(true);
    expect(built.actions).toEqual([]);
    expect(built.outOfScopeReason).toBeTruthy();
  });

  it('REPLACE_CTA com chamada escolhida emite ação executável', () => {
    const [built] = plan(
      signals({
        ad: { roas: 0.5, peerMedianRoas: 4 },
        selectedCopy: {
          variantId: 'variant-1',
          primaryText: null,
          callToAction: 'SIGN_UP',
          aiAuthored: true,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built.advisory).toBe(false);
    expect(built.actions).toHaveLength(1);
    expect(built.actions[0].type).toBe('REPLACE_CTA');
    expect(built.actions[0].parameters).toMatchObject({
      callToAction: 'SIGN_UP',
      // R14: a autoria viaja no parâmetro, e é ela que exige a confirmação do
      // texto final na execução. Um `aiAuthored` ausente ou deduzido no destino
      // é como texto de LLM chegaria à plataforma declarado como humano.
      aiAuthored: true,
    });
    // §13.3 — o aviso de recriação é obrigatório antes da confirmação.
    expect(built.actions[0].scopeWarning).toContain('marca');
    expect(built.actions[0].reversible).toBe(false);
  });

  /**
   * No Google o CTA é campo do display e do Demand Gen, não do anúncio de
   * busca. Planejar a troca na busca produziria uma ação que o dry-run recusa
   * depois de a pessoa aprovar a recomendação.
   */
  it('REPLACE_CTA no anúncio de busca do Google continua consultiva', () => {
    const [built] = plan(
      signals({
        ad: {
          platform: 'GOOGLE',
          creativeFormat: 'RESPONSIVE_SEARCH_AD',
          roas: 0.5,
          peerMedianRoas: 4,
        },
        selectedCopy: {
          variantId: 'variant-1',
          primaryText: null,
          callToAction: 'Peça uma demonstração',
          aiAuthored: true,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built.advisory).toBe(true);
    expect(built.actions).toEqual([]);
  });

  it('REPLACE_CTA no display responsivo do Google emite ação executável', () => {
    const [built] = plan(
      signals({
        ad: {
          platform: 'GOOGLE',
          creativeFormat: 'RESPONSIVE_DISPLAY_AD',
          roas: 0.5,
          peerMedianRoas: 4,
        },
        selectedCopy: {
          variantId: 'variant-1',
          primaryText: null,
          callToAction: 'Peça uma demonstração',
          aiAuthored: true,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built.advisory).toBe(false);
    expect(built.actions[0]).toMatchObject({
      type: 'REPLACE_CTA',
      parameters: { callToAction: 'Peça uma demonstração' },
      // Edição em lugar no Google: o id do anúncio permanece.
      requiresRecreate: false,
    });
  });

  it('uma variação só com texto principal não destrava REPLACE_CTA', () => {
    // Os dois campos são ações diferentes, com estratégias de mutação
    // diferentes por plataforma: um texto principal não é uma chamada.
    const [built] = plan(
      signals({
        ad: { roas: 0.5, peerMedianRoas: 4 },
        selectedCopy: {
          variantId: 'variant-1',
          primaryText: 'Pare de perder horas analisando campanhas.',
          callToAction: null,
          aiAuthored: true,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built.advisory).toBe(true);
    expect(built.actions).toEqual([]);
  });

  it('CREATIVE_FATIGUE sem substituto vira consultiva, não some', () => {
    const [built] = plan(
      signals({
        findings: [finding({ type: 'CREATIVE_FATIGUE', priority: 'HIGH' })],
        replacementCreativeId: null,
      }),
    ).filter((item) => item.kind === 'REFRESH_FATIGUED_CREATIVE');

    expect(built.advisory).toBe(true);
    expect(built.actions).toEqual([]);
    expect(built.guidance).toContain('Suba um criativo novo');
    expect(built.outOfScopeReason).toBeTruthy();
  });

  /**
   * **A recriação é por plataforma, e a Meta não recria aqui.**
   *
   * Até A2-S8 uma lista global respondia `true` para toda plataforma. Ela errava
   * nos dois sentidos: dizia que a Meta cria anúncio novo ao trocar o criativo
   * (não cria — o `ad_id` permanece) e que o Google não o faz (faz). Herdar essa
   * resposta significava linhagem esperando um sucessor que a plataforma nunca
   * produziu.
   *
   * O que **não** mudou é o aviso: trocar o criativo reinicia o aprendizado e
   * zera a prova social na Meta. Esse é o impacto, e ele vive separado da
   * estratégia justamente porque uma edição em lugar também o causa.
   */
  it('CREATIVE_FATIGUE com substituto propõe REPLACE_CREATIVE editando em lugar na Meta', () => {
    const [built] = plan(
      signals({
        findings: [finding({ type: 'CREATIVE_FATIGUE' })],
        replacementCreativeId: 'creative-novo',
      }),
    ).filter((item) => item.kind === 'REFRESH_FATIGUED_CREATIVE');

    expect(built.advisory).toBe(false);
    expect(built.actions[0]).toMatchObject({
      type: 'REPLACE_CREATIVE',
      // Meta: o anúncio é o mesmo depois da troca.
      requiresRecreate: false,
    });
    expect(built.actions[0].parameters).toMatchObject({
      creativeId: 'creative-novo',
    });
    // O aviso permanece: o impacto não depende de a plataforma recriar.
    expect(built.actions[0].scopeWarning).toContain('aprendizado');
  });

  it('AUDIENCE_SATURATION é consultiva por escopo, com orientação', () => {
    const [built] = plan(
      signals({ findings: [finding({ type: 'AUDIENCE_SATURATION' })] }),
    ).filter((item) => item.kind === 'EXPAND_AUDIENCE');

    expect(built.advisory).toBe(true);
    expect(built.actions).toEqual([]);
    expect(built.outOfScopeReason).toContain('A Allva não gere audiências');
  });

  it('HIGH_CPA reduz o orçamento do conjunto, na moeda da CONTA (M3)', () => {
    const [built] = plan(
      signals({
        findings: [finding({ type: 'HIGH_CPA' })],
        ad: { currency: 'USD', baseCurrency: 'BRL' },
      }),
    ).filter((item) => item.kind === 'REDUCE_BUDGET_HIGH_CPA');

    expect(built.actions[0]).toMatchObject({
      type: 'ADJUST_AD_SET_BUDGET',
      targetEntityType: 'AD_SET',
    });
    // 100 × (1 − 0,3) = 70, na moeda da conta. Enviar a base moveria dinheiro
    // real na quantia errada.
    expect(built.actions[0].parameters).toMatchObject({
      dailyBudget: 70,
      previousDailyBudget: 100,
      currency: 'USD',
    });
  });
});

/**
 * §9.3 — a única recomendação que **aumenta** gasto, e a que exige mais
 * evidência. As seis guardas existem porque o próprio `aiScore` as torna
 * necessárias: ele inclui fadiga com peso 0,15 invertido, e um criativo campeão
 * em fim de vida cruza os 75 pontos.
 */
describe('as seis guardas de SCALE_WINNING_AD', () => {
  const winner = () =>
    signals({
      findings: [
        finding({
          type: 'BUDGET_STARVATION',
          findingKind: 'OPPORTUNITY',
          priority: 'MEDIUM',
        }),
      ],
    });

  it('são seis, e o registro é a lista', () => {
    expect(SCALE_GUARDS.map((guard) => guard.name)).toEqual([
      'FATIGUE',
      'SATURATION',
      'FREQUENCY',
      'CONFIDENCE',
      'MATURITY',
      'STABILITY',
    ]);
  });

  it('anúncio campeão íntegro passa e propõe aumento', () => {
    const [built] = plan(winner()).filter(
      (item) => item.kind === 'SCALE_WINNING_AD',
    );

    expect(built.blockedReason).toBeNull();
    // 100 × (1 + 0,2) = 120.
    expect(built.actions[0].parameters).toMatchObject({ dailyBudget: 120 });
  });

  it('score alto com fadiga alta é retido — o caso que o composto esconde', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      score: { ...base.score!, fatigueScore: 0.7 },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blockedReason).toContain('fadiga');
  });

  it('fadiga em alta bloqueia mesmo abaixo do corte absoluto', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      score: { ...base.score!, fatigueScore: 0.3, delta7d: -8 },
    });

    expect(verdict.blockedReason).toContain('fadiga em alta');
  });

  it('saturação no CONJUNTO bloqueia, não só no anúncio', () => {
    // `AUDIENCE_SATURATION` é de escopo `AD_SET` e é atribuído a um anúncio só:
    // olhar apenas o atribuído deixaria os outros do mesmo público passarem.
    const verdict = evaluateScaleGuards({
      ...winner(),
      adSetFindingTypes: ['AUDIENCE_SATURATION'],
    });

    expect(verdict.blockedReason).toContain('saturação');
    expect(verdict.blockedReason).toContain('no conjunto');
  });

  it('frequência acima do limiar bloqueia sem achado aberto', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      ad: { ...base.ad, frequency: 5 },
    });

    expect(verdict.blockedReason).toContain('frequência');
  });

  it('anúncio novo não é anúncio campeão — confiança abaixo de 0,70 bloqueia', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      score: { ...base.score!, aiConfidence: 0.5 },
    });

    expect(verdict.blockedReason).toContain(
      'anúncio novo não é anúncio campeão',
    );
  });

  it('janela imatura bloqueia — ROAS é re-declarado', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      ad: { ...base.ad, dataMaturity: 'SETTLING' },
    });

    expect(verdict.blockedReason).toContain('re-declarado');
  });

  it('aprendizado instável bloqueia — escalar o reinicia', () => {
    const base = winner();
    const verdict = evaluateScaleGuards({
      ...base,
      score: { ...base.score!, learningStability: 20 },
    });

    expect(verdict.blockedReason).toContain('instável');
  });

  it('bloqueio NÃO some: o plano existe, com blockedReason e sem ação', () => {
    // §9.3: "Bloqueio não some em silêncio: gera a recomendação com
    // `blockedReason` visível" — informação ao usuário e sinal de calibração.
    const base = winner();
    const [built] = plan({
      ...base,
      score: { ...base.score!, fatigueScore: 0.9 },
    }).filter((item) => item.kind === 'SCALE_WINNING_AD');

    expect(built).toBeDefined();
    expect(built.blockedReason).toContain('fadiga');
    expect(built.actions).toEqual([]);
  });

  it('ROAS abaixo do dobro da mediana não qualifica sequer para avaliação', () => {
    // A entrada é dupla: score alto **e** ROAS ≥ 2× a mediana dos pares. Sem o
    // segundo, "campeão" seria o nosso modelo concordando consigo mesmo.
    const base = winner();
    const built = plan({
      ...base,
      ad: { ...base.ad, roas: 1.5, peerMedianRoas: 1 },
    }).filter((item) => item.kind === 'SCALE_WINNING_AD');

    expect(built).toEqual([]);
  });
});

describe('REPLACE_CTA nasce do score, não de achado', () => {
  it('público certo chegando e conversão abaixo dos pares ⇒ consultiva', () => {
    const built = plan(
      signals({
        findings: [],
        ad: { roas: 0.5, peerMedianRoas: 2 },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built).toHaveLength(1);
    expect(built[0].advisory).toBe(true);
    expect(built[0].rationale).toContain('depois do clique');
    expect(built[0].wasteItemIds).toEqual([]);
  });

  it('audience fit baixo não é problema de CTA', () => {
    const base = signals({
      findings: [],
      ad: { roas: 0.5, peerMedianRoas: 2 },
    });

    expect(
      plan({ ...base, score: { ...base.score!, audienceFit: 20 } }).filter(
        (item) => item.kind === 'REPLACE_CTA',
      ),
    ).toEqual([]);
  });
});

describe('todos os eventos de conversão, não só compra', () => {
  const opportunity = finding({
    type: 'BUDGET_STARVATION',
    findingKind: 'OPPORTUNITY',
    priority: 'MEDIUM',
  });

  it('anúncio de lead que converte pela metade do CPA dos pares é candidato a escala', () => {
    // Lead não tem receita: ROAS zero para todos, e a régua passa a ser o CPA.
    const built = plan(
      signals({
        findings: [opportunity],
        ad: {
          optimization: conversionTarget('LEAD'),
          roas: 0,
          peerMedianRoas: 0,
          cpa: 10,
          peerMedianCpa: 25,
        },
      }),
    ).filter((item) => item.kind === 'SCALE_WINNING_AD');

    expect(built).toHaveLength(1);
    expect(built[0].blockedReason).toBeNull();
  });

  it('lead com CPA só um pouco melhor que os pares não qualifica', () => {
    const built = plan(
      signals({
        findings: [opportunity],
        ad: {
          optimization: conversionTarget('LEAD'),
          roas: 0,
          peerMedianRoas: 0,
          cpa: 20,
          peerMedianCpa: 25,
        },
      }),
    ).filter((item) => item.kind === 'SCALE_WINNING_AD');

    expect(built).toEqual([]);
  });

  it.each(['TRAFFIC', 'AWARENESS'] as const)(
    'anúncio de %s nunca é recomendado para escalar — escalar exige saber o que ele converte',
    (cls) => {
      const built = plan(
        signals({
          findings: [opportunity],
          ad: { optimization: nonConversionTarget(cls) },
        }),
      ).filter((item) => item.kind === 'SCALE_WINNING_AD');

      expect(built).toEqual([]);
    },
  );

  it('troca de CTA não é proposta para anúncio que não busca conversão', () => {
    const built = plan(
      signals({
        findings: [],
        ad: {
          optimization: nonConversionTarget('TRAFFIC'),
          roas: 0.5,
          peerMedianRoas: 2,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built).toEqual([]);
  });

  it('troca de CTA em anúncio de lead compara pelo custo por conversão', () => {
    const built = plan(
      signals({
        findings: [],
        ad: {
          optimization: conversionTarget('LEAD'),
          roas: 0,
          peerMedianRoas: 0,
          cpa: 40,
          peerMedianCpa: 20,
        },
      }),
    ).filter((item) => item.kind === 'REPLACE_CTA');

    expect(built).toHaveLength(1);
    expect(built[0].rationale).toContain('custo por conversão');
  });
});
