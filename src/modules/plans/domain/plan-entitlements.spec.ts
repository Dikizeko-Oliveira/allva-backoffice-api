import { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { ACTION_TYPE_FEATURE } from 'src/modules/platform-actions/domain/rbac/action-plan-entitlements';
import {
  PLAN_FEATURE_SPECS,
  cellFor,
  resolvePlanFeatures,
} from './plan-catalog';
import {
  ENFORCED_FEATURE_KEYS,
  cheapestPlanWith,
  featureLabel,
  planAllows,
  planLabel,
} from './plan-entitlements';

describe('a guarda lê o mesmo catálogo que a landing', () => {
  it.each(ENFORCED_FEATURE_KEYS)('%s existe no catálogo', (key) => {
    expect(PLAN_FEATURE_SPECS.some((spec) => spec.key === key)).toBe(true);
  });

  it.each(ENFORCED_FEATURE_KEYS)(
    '%s: o que a guarda libera é o que a vitrine mostra, plano a plano',
    (key) => {
      for (const type of ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'] as const) {
        const advertised = resolvePlanFeatures(type).find(
          (feature) => feature.key === key,
        )!.enabled;

        expect(planAllows(type, key)).toBe(advertised);
      }
    },
  );

  it('a recusa cita o rótulo do catálogo, não o slug', () => {
    expect(featureLabel('budget-actions')).toBe(
      'Ações de orçamento, conjunto e campanha',
    );
  });

  /**
   * **Nenhum teto publicado sem guarda que o aplique.**
   *
   * É a trava que faltava, e a razão de ela faltar tem nome: o packaging já foi
   * vitrine por inteiro, e o único jeito de descobrir que uma linha prometia um
   * número sem parede era alguém estourá-lo em produção. Foi assim que a
   * análise de criativo passou a existir sem teto nenhum enquanto o card de
   * preços seguia vendendo volume.
   *
   * Uma célula `{ quota }` é uma promessa de quantidade, e agora **toda** uma
   * tem guarda. Houve uma exceção — `monthly-analyses`, que publicava teto e não
   * recusava nada —, e ela saiu do catálogo em vez de virar categoria: era
   * derivada de `monitored-ads`, então eram dois números para a mesma restrição.
   */
  it('toda linha com teto numérico tem guarda que a aplica', () => {
    const declared = new Set<string>(ENFORCED_FEATURE_KEYS);

    const promisedButUngoverned = PLAN_FEATURE_SPECS.filter((spec) =>
      (['STARTER', 'PRO', 'ENTERPRISE'] as const).some((type) => {
        const cell = cellFor(spec, type);
        return typeof cell === 'object' && 'quota' in cell;
      }),
    )
      .map((spec) => spec.key)
      .filter((key) => !declared.has(key));

    expect(promisedButUngoverned).toEqual([]);
  });
});

describe('o que cada plano libera na superfície de escrita', () => {
  it('Individual age no anúncio e para no conjunto', () => {
    expect(planAllows('STARTER', 'ad-actions')).toBe(true);
    expect(planAllows('STARTER', 'budget-actions')).toBe(false);
    expect(planAllows('STARTER', 'batch-actions')).toBe(false);
  });

  /**
   * "Inteira" passou a ter exceção nomeada, e a exceção não é de produto.
   *
   * O Profissional continua liberando tudo que é **capacidade de produto** —
   * era esse o conteúdo do teste. O que ele não tem são as duas linhas de
   * atendimento que o Enterprise vende à parte, e que deixaram de ser vitrine
   * quando a Central de suporte passou a recusá-las de verdade. A lista é
   * explícita, e não um filtro pelo catálogo, justamente para que uma chave
   * nova de produto que o PRO não inclua caia aqui como falha em vez de ser
   * absorvida em silêncio.
   */
  const ENTERPRISE_ONLY_KEYS = new Set<string>([
    'support-dedicated-channel',
    'support-onboarding',
  ]);

  it('Profissional libera a superfície inteira de produto', () => {
    for (const key of ENFORCED_FEATURE_KEYS) {
      if (ENTERPRISE_ONLY_KEYS.has(key)) continue;
      expect(planAllows('PRO', key)).toBe(true);
    }
  });

  it('as linhas de atendimento exclusivas ficam só no Enterprise', () => {
    for (const key of ENTERPRISE_ONLY_KEYS) {
      const enterpriseOnly = key as 'support-dedicated-channel';
      expect(planAllows('STARTER', enterpriseOnly)).toBe(false);
      expect(planAllows('PRO', enterpriseOnly)).toBe(false);
      expect(planAllows('ENTERPRISE', enterpriseOnly)).toBe(true);
    }
  });

  it('o teste gratuito libera o mesmo que o Profissional', () => {
    for (const key of ENFORCED_FEATURE_KEYS) {
      expect(planAllows('FREE', key)).toBe(planAllows('PRO', key));
    }
  });

  it('fecha na dúvida — escrita em mídia paga não erra para o lado permissivo', () => {
    expect(planAllows(null, 'ad-actions')).toBe(false);
    expect(planAllows(undefined, 'budget-actions')).toBe(false);
  });
});

describe('as quatro capacidades de suporte que a guarda aplica', () => {
  it('Individual, Profissional e Enterprise têm suporte por e-mail', () => {
    expect(planAllows('STARTER', 'support-email')).toBe(true);
    expect(planAllows('PRO', 'support-email')).toBe(true);
    expect(planAllows('ENTERPRISE', 'support-email')).toBe(true);
  });

  it('fecha na dúvida — plano irresolúvel não envia suporte', () => {
    expect(planAllows(null, 'support-email')).toBe(false);
    expect(planAllows(undefined, 'support-email')).toBe(false);
  });
});

describe('para onde a recusa aponta', () => {
  it('indica o plano contratável mais barato que inclui', () => {
    expect(cheapestPlanWith('ad-actions')).toBe('Individual');
    expect(cheapestPlanWith('budget-actions')).toBe('Profissional');
  });

  it('nunca manda o usuário "contratar" o teste gratuito', () => {
    // O teste custa zero e espelha o PRO: sem excluí-lo, ele seria sempre o
    // mais barato — e a recusa mandaria o usuário de volta ao que ele perdeu.
    for (const key of ENFORCED_FEATURE_KEYS) {
      expect(cheapestPlanWith(key)).not.toBe('Teste Gratuito');
    }
  });

  it('nomeia o plano vigente, e degrada sem quebrar a frase', () => {
    expect(planLabel('STARTER')).toBe('Individual');
    expect(planLabel(null)).toBe('atual');
  });
});

describe('o mapa de ação → plano é total', () => {
  it('toda ação declara uma chave, e a chave é aplicável', () => {
    const types = Object.keys(ACTION_TYPE_FEATURE) as AdActionType[];

    // Treze ações no catálogo de §13.1. Uma ação nova sem entrada aqui não
    // compila — é a mesma totalidade de `ACTION_TYPE_PERMISSION`.
    expect(types).toHaveLength(13);

    for (const type of types) {
      expect(ENFORCED_FEATURE_KEYS).toContain(ACTION_TYPE_FEATURE[type]);
    }
  });

  it('o eixo do plano não é o do RBAC — os dois discordam de propósito', () => {
    // `PAUSE_AD_SET` é baixo estrago (qualquer analista pode) e ao mesmo tempo
    // acima do anúncio (só a partir do Profissional). Se algum dia os dois mapas
    // coincidirem em tudo, um deles virou cópia do outro.
    expect(ACTION_TYPE_FEATURE.PAUSE_AD_SET).toBe('budget-actions');
    expect(ACTION_TYPE_FEATURE.ARCHIVE_AD).toBe('ad-actions');
  });
});
