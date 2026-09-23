import { PLAN_SEAT_LIMITS } from 'src/modules/organizations/domain/plan-seat-limits';
import {
  FEATURE_SECTIONS,
  HIGHLIGHT_LIMIT,
  PLAN_FEATURE_SPECS,
  PLAN_SPECS,
  TRIAL_MIRRORS,
  distinguishesContractablePlans,
  highlightPlanFeatures,
  isContactSalesPlan,
  resolvePlanFeatures,
  sectionFor,
} from './plan-catalog';

describe('catálogo de planos', () => {
  it('tem exatamente um plano por tipo — `Plan.type` é @unique', () => {
    const types = PLAN_SPECS.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toHaveLength(4);
  });

  it('não repete `key` entre features — é a chave de agrupamento da landing', () => {
    const keys = PLAN_FEATURE_SPECS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('os assentos anunciados são os que a guarda aplica, em todo plano', () => {
    // `PLAN_SEAT_LIMITS` é quem recusa o convite; o catálogo é vitrine. Só o
    // FREE era comparado, e as outras três colunas podiam divergir em silêncio
    // — que é exatamente a landing prometer assentos que o convite recusa.
    for (const plan of PLAN_SPECS) {
      const advertised = resolvePlanFeatures(plan.type).find(
        (feature) => feature.key === 'seats',
      )!.value;

      const enforced = PLAN_SEAT_LIMITS[plan.type];

      // O texto pode ser prosa ("Sob medida (a partir de 25)"), mas o número
      // que ele mostra tem de ser o que a guarda aplica — divergir é a landing
      // prometer assentos que o convite recusa.
      expect(enforced).not.toBeNull();
      expect(advertised).toContain(String(enforced));
    }
  });

  it('só o FREE declara janela de teste, e só ele é gratuito', () => {
    for (const plan of PLAN_SPECS) {
      if (plan.type === 'FREE') {
        expect(plan.trialDays).toBeGreaterThan(0);
        expect(plan.amount).toBe(0);
      } else {
        expect(plan.trialDays).toBeNull();
        expect(plan.amount).toBeGreaterThan(0);
      }
    }
  });
});

describe('o teste gratuito entrega o produto inteiro', () => {
  const free = resolvePlanFeatures('FREE');
  const mirrored = resolvePlanFeatures(TRIAL_MIRRORS);

  /**
   * A única linha em que o teste difere de propósito. Prioridade de atendimento
   * é promessa comercial, não capacidade de produto.
   */
  const DELIBERATE_OVERRIDES = ['support'];

  it.each(
    free
      .filter((f) => !DELIBERATE_OVERRIDES.includes(f.key))
      .map((f) => [f.key] as const),
  )('%s é idêntico ao plano espelhado', (key) => {
    const trial = free.find((f) => f.key === key)!;
    const paid = mirrored.find((f) => f.key === key)!;

    expect({ enabled: trial.enabled, value: trial.value }).toEqual({
      enabled: paid.enabled,
      value: paid.value,
    });
  });

  it('a única divergência declarada é a de suporte', () => {
    const diverging = free.filter((trial) => {
      const paid = mirrored.find((f) => f.key === trial.key)!;
      return trial.enabled !== paid.enabled || trial.value !== paid.value;
    });

    expect(diverging.map((f) => f.key)).toEqual(DELIBERATE_OVERRIDES);
  });

  it('o teto de assentos aplicado concorda com o que o catálogo mostra', () => {
    // A guarda é `PLAN_SEAT_LIMITS`; o catálogo é vitrine. Divergir significa a
    // landing prometer assentos que o convite recusa.
    const advertised = free.find((f) => f.key === 'seats')!.value;

    expect(advertised).toBe(String(PLAN_SEAT_LIMITS.FREE));
    expect(PLAN_SEAT_LIMITS.FREE).toBe(PLAN_SEAT_LIMITS[TRIAL_MIRRORS]);
  });
});

describe('projeção das linhas de plan_features', () => {
  it('um limite em texto vira feature LIGADA com valor, nunca desligada', () => {
    const ads = resolvePlanFeatures('STARTER').find(
      (f) => f.key === 'monitored-ads',
    )!;

    expect(ads.enabled).toBe(true);
    expect(ads.value).toBe('300');
  });

  it('uma feature liga/desliga não carrega valor', () => {
    const impact = resolvePlanFeatures('STARTER').find(
      (f) => f.key === 'measured-impact',
    )!;

    expect(impact.enabled).toBe(false);
    expect(impact.value).toBeNull();
  });

  it('todo plano projeta o catálogo inteiro — a matriz não tem buraco', () => {
    for (const plan of PLAN_SPECS) {
      expect(resolvePlanFeatures(plan.type)).toHaveLength(
        PLAN_FEATURE_SPECS.length,
      );
    }
  });
});

/**
 * O defeito que estas asserções existem para pegar: o card do Individual
 * anunciando nove linhas em que ele é igual aos outros dois.
 *
 * Ele não chega por alguém escrever uma linha errada — chega por escolher as
 * nove pela ordem. As primeiras do catálogo são o bloco de Cobertura inteiro:
 * quotas que todo plano tem, só com números diferentes. O "–" que vende o plano
 * de cima mora em `creative-lab` (14), `ai-narratives` (15) e `budget-actions`
 * (21), e nenhum deles entraria num `.slice(0, 8)`.
 */
describe('o card mostra o que faz alguém escolher um plano', () => {
  const highlights = PLAN_FEATURE_SPECS.filter((spec) => spec.highlight);

  it('cabe no card', () => {
    expect(highlights.length).toBeLessThanOrEqual(HIGHLIGHT_LIMIT);
    expect(highlights.length).toBeGreaterThan(0);
  });

  /**
   * O card **usa as nove vagas**, e a geração de copy é uma delas.
   *
   * Sem esta asserção, o destaque some no primeiro ajuste distraído do
   * catálogo — e ninguém percebe, porque o card continua renderizando, só que
   * com oito linhas. É a mesma classe de defeito que o teste acima pega: uma
   * mudança de packaging que só aparece na página de preços.
   */
  it('a geração de copy ocupa a nona vaga do card', () => {
    expect(highlights).toHaveLength(HIGHLIGHT_LIMIT);
    expect(highlights.map((spec) => spec.key)).toContain('copy-generation');
  });

  it('todo destaque separa dois planos contratáveis, ou nomeia o produto', () => {
    // `waste-detector` é plano de propósito: sem ao menos uma linha dizendo o
    // que a ferramenta faz, o card do Individual seria uma coluna de números e
    // traços. Qualquer OUTRA linha plana promovida a destaque gasta uma das
    // linhas repetindo o vizinho, e cai aqui.
    const NAMES_THE_PRODUCT = ['waste-detector'];

    const flat = highlights
      .filter(
        (spec) =>
          !distinguishesContractablePlans(spec) &&
          !NAMES_THE_PRODUCT.includes(spec.key),
      )
      .map((spec) => spec.key);

    expect(flat).toEqual([]);
  });

  it('o Individual mostra pelo menos dois "–" — é a escada do upgrade', () => {
    const missing = highlightPlanFeatures('STARTER').filter((f) => !f.enabled);

    expect(missing.length).toBeGreaterThanOrEqual(2);
  });

  it('o destaque é uniforme entre planos — os cards se leem lado a lado', () => {
    for (const spec of PLAN_FEATURE_SPECS) {
      const perPlan = PLAN_SPECS.map(
        (plan) =>
          resolvePlanFeatures(plan.type).find((f) => f.key === spec.key)!
            .landingHighlight,
      );

      expect(new Set(perPlan).size).toBe(1);
    }
  });

  it('sair do card não desliga a feature para a guarda', () => {
    // O erro que a coluna separada existe para tornar impossível: `enabled` é a
    // pergunta da guarda, `landingHighlight` é a do card. As duas são
    // independentes, e `rbac` é a prova concreta — fora do card em todo plano,
    // e incluído em todos eles.
    const rbac = resolvePlanFeatures('PRO').find((f) => f.key === 'rbac')!;

    expect(rbac.landingHighlight).toBe(false);
    expect(rbac.enabled).toBe(true);

    // Não é caso isolado: a maior parte do que sai do card segue ligada. (O
    // inverso também existe — `ai-daily-budget` está fora do card e desligada
    // no PRO —, e é por isso que a asserção não é "todas ligadas".)
    const stillOn = resolvePlanFeatures('PRO').filter(
      (feature) => !feature.landingHighlight && feature.enabled,
    );

    expect(stillOn.length).toBeGreaterThan(10);
  });

  it('o card sai ordenado, para o front não reordenar nada', () => {
    const order = highlightPlanFeatures('STARTER').map((f) => f.sortOrder);

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

/**
 * A tabela comparativa renderiza as 31 linhas agrupadas, e o agrupamento é
 * derivado de `sortOrder` — não anotado linha a linha. Estas asserções cobram
 * que a convenção continue verdadeira, porque ela deixou de ser só convenção no
 * dia em que a tabela passou a depender dela.
 */
describe('as seções da tabela comparativa', () => {
  it('toda linha cai numa seção', () => {
    for (const spec of PLAN_FEATURE_SPECS) {
      expect(FEATURE_SECTIONS.map((s) => s.label)).toContain(
        sectionFor(spec.sortOrder),
      );
    }
  });

  it('nenhuma seção fica vazia — uma faixa sem linha é bloco morto', () => {
    for (const section of FEATURE_SECTIONS) {
      const rows = PLAN_FEATURE_SPECS.filter(
        (spec) => sectionFor(spec.sortOrder) === section.label,
      );

      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('ordenar por sortOrder já agrupa — a tabela nunca repete um cabeçalho', () => {
    // Se uma linha de Governança recebesse `sortOrder: 12`, ela apareceria no
    // meio de Inteligência e a seção "Governança" abriria duas vezes.
    const sections = resolvePlanFeatures('PRO')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((feature) => feature.section);

    const opened = sections.filter(
      (section, index) => section !== sections[index - 1],
    );

    expect(opened).toEqual([...new Set(sections)]);
  });

  describe('planos fechados por proposta', () => {
    it('só o Enterprise é negociado com o comercial', () => {
      const negotiated = PLAN_SPECS.filter((spec) =>
        isContactSalesPlan(spec.type),
      ).map((spec) => spec.type);

      expect(negotiated).toEqual(['ENTERPRISE']);
    });

    it('o preço do Enterprise é piso de vitrine, não preço de contrato', () => {
      // O número existe para a landing dizer "a partir de". Se ele algum dia
      // virar um preço a cobrar, `contactSalesOnly` é que precisa cair junto —
      // as guardas de assinatura, troca e checkout leem essa coluna.
      const enterprise = PLAN_SPECS.find((spec) => spec.type === 'ENTERPRISE');

      expect(enterprise?.amount).toBeGreaterThan(0);
      expect(enterprise?.contactSalesOnly).toBe(true);
      // Sem ciclo anual: não há tabela de preço a publicar.
      expect(enterprise?.amountAnnual).toBeNull();
    });

    it('os planos de autoatendimento continuam contratáveis', () => {
      expect(isContactSalesPlan('FREE')).toBe(false);
      expect(isContactSalesPlan('STARTER')).toBe(false);
      expect(isContactSalesPlan('PRO')).toBe(false);
    });
  });

  it('a matriz tem 37 linhas em 5 seções', () => {
    // Eram 31, depois 32: "Organizações" voltou quando a migração de
    // multi-organização tornou verdade o que a linha dizia. Virou 36 quando
    // `support` ganhou quatro linhas booleanas irmãs (`support-email` e
    // companhia) para o Drawer de suporte poder ler capacidade sem parsear
    // prosa — ver o comentário em `support-email`. E 37 com `copy-generation`,
    // a primeira linha do catálogo com cota **mensal** — e a nona do card, que
    // passou de oito para nove em vez de um destaque ceder o lugar.
    //
    // 38 com `creative-analyses`: a segunda cota mensal, e a que fechou a última
    // ação por clique sem parede de plano. Ela **não** entra no card — o limite
    // de destaques segue em nove, e a linha não carrega o "–" do Individual.
    //
    // De volta a 37 com a saída de `monthly-analyses`: ela publicava um teto que
    // nada aplicava, e era derivada de `monitored-ads` — dois números para a
    // mesma restrição, com o não-aplicado sendo o que ninguém revisitava.
    expect(PLAN_FEATURE_SPECS).toHaveLength(37);
    expect(FEATURE_SECTIONS).toHaveLength(5);
  });
});

/**
 * O mapeamento comercial pedido para o Drawer de suporte: as quatro linhas
 * booleanas por trás de `support` concordam com o que cada plano vende.
 */
describe('capacidades granulares de suporte', () => {
  const supportKeys = [
    'support-email',
    'support-priority',
    'support-dedicated-channel',
    'support-onboarding',
  ] as const;

  it.each(supportKeys)('%s existe no catálogo', (key) => {
    expect(PLAN_FEATURE_SPECS.some((spec) => spec.key === key)).toBe(true);
  });

  it('Individual: só e-mail', () => {
    const features = resolvePlanFeatures('STARTER');
    expect(features.find((f) => f.key === 'support-email')!.enabled).toBe(true);
    expect(features.find((f) => f.key === 'support-priority')!.enabled).toBe(
      false,
    );
    expect(
      features.find((f) => f.key === 'support-dedicated-channel')!.enabled,
    ).toBe(false);
    expect(features.find((f) => f.key === 'support-onboarding')!.enabled).toBe(
      false,
    );
  });

  it('Profissional: e-mail + prioridade', () => {
    const features = resolvePlanFeatures('PRO');
    expect(features.find((f) => f.key === 'support-email')!.enabled).toBe(true);
    expect(features.find((f) => f.key === 'support-priority')!.enabled).toBe(
      true,
    );
    expect(
      features.find((f) => f.key === 'support-dedicated-channel')!.enabled,
    ).toBe(false);
    expect(features.find((f) => f.key === 'support-onboarding')!.enabled).toBe(
      false,
    );
  });

  it('Enterprise: as quatro capacidades', () => {
    const features = resolvePlanFeatures('ENTERPRISE');
    for (const key of supportKeys) {
      expect(features.find((f) => f.key === key)!.enabled).toBe(true);
    }
  });

  it('o teste gratuito espelha o Profissional, como as demais linhas', () => {
    for (const key of supportKeys) {
      const trial = resolvePlanFeatures('FREE').find((f) => f.key === key)!;
      const pro = resolvePlanFeatures('PRO').find((f) => f.key === key)!;
      expect(trial.enabled).toBe(pro.enabled);
    }
  });
});
