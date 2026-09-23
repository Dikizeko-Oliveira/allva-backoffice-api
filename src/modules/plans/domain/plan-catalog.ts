export type PlanType = 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';

/**
 * O catálogo de planos como **dado**, não como INSERT solto num arquivo de
 * migração.
 *
 * É o que a landing page mostra e o que `GET /api/v1/plans` responde, então ele
 * precisa ser lido e revisado por quem escreve a página de preços — não
 * arqueologicamente recuperado de um `.sql` já aplicado. O seed
 * (`scripts/seed-plans.ts`) projeta isto no banco de forma idempotente.
 *
 * **Uma célula de texto é vitrine; uma célula `{ quota }` é a fonte de
 * verdade.** A distinção é o que resta de "este arquivo não é fonte de verdade
 * de limite", que era verdade quando toda linha era prosa. Hoje `planQuota` lê
 * as células numéricas, e quem aplica o teto — contas de anúncios, anúncios
 * analisados, gerações de copy, análises de criativo — lê daqui.
 *
 * A exceção que sobra é `PLAN_SEAT_LIMITS`, que continua recusando o 4º convite
 * do plano de 3 assentos a partir de uma constante própria; há teste cobrando
 * que os dois números concordem.
 *
 * **Não há mais caso intermediário.** `monthly-analyses` publicava "100 / 350"
 * sem nada aplicar, e saiu: o número era *derivado* de `monitored-ads` — os
 * achados vêm dos anúncios que a régua da noite deixou entrar —, então eram
 * duas linhas descrevendo a mesma restrição, e a que ninguém aplicava era a que
 * ninguém revisitava. Com o rodízio da varredura ela ficaria pior que inútil:
 * passaria a prometer menos do que o produto entrega.
 *
 * ## Duas perguntas, duas colunas
 *
 * `enabled` responde **"o plano inclui?"** — é o que a guarda lê. `highlight`
 * responde **"isto cabe no card?"**, que é outra pergunta inteiramente: o card
 * do plano tem espaço para umas nove linhas, e a tabela comparativa mostra o
 * catálogo inteiro.
 *
 * Sem a segunda coluna, encurtar o card exigiria desligar features — mentir
 * para a guarda para consertar a página de preços — ou manter no front uma
 * lista de chaves escolhidas à mão, que divergiria do packaging no primeiro
 * ajuste. Com ela, o card mostra {@link highlightPlanFeatures}, a tabela mostra
 * {@link resolvePlanFeatures} agrupado por {@link sectionFor}, e as duas leem o
 * mesmo catálogo.
 */

/**
 * Uma célula da matriz.
 *
 * As duas primeiras formas são vitrine pura — a guarda só sabe perguntar "está
 * ligado?". As duas últimas carregam o limite **legível por máquina** ao lado do
 * texto, e existem porque a alternativa era a guarda interpretar prosa:
 * `"2.000"` tem ponto de milhar, `"Ilimitadas"` concorda em gênero com a
 * feature, `"Meta + Google"` é uma lista escrita com `+`. Uma guarda que
 * fizesse `parseInt` nisso funcionaria até alguém corrigir um acento.
 *
 * O `display` continua sendo escrito à mão, e não derivado do número: singular e
 * plural, gênero e unidade mudam por linha ("1 modelo", "300", "Ilimitadas"), e
 * um renderizador que acertasse todos os casos seria mais frágil que a
 * duplicação — que, essa sim, tem teste cobrando que os dois concordem.
 */
export type FeatureCell =
  | boolean
  | string
  /** Teto numérico. `null` é ilimitado; `0` desliga a feature. */
  | { quota: number | null; display: string }
  /** Subconjunto enumerado — plataformas, modelos de relatório. */
  | { allow: readonly string[]; display: string };

/**
 * O plano que o teste gratuito espelha.
 *
 * **O teste entrega o produto inteiro, e a parede é o calendário.** Num plano
 * gratuito perpétuo faz sentido mostrar o diagnóstico e negar a ação: a
 * frustração acumula e vende o upgrade. Num teste de 14 dias não há tempo para
 * frustração acumular — quem nunca pausou um anúncio nem recebeu um alerta não
 * tem do que sentir falta no dia 15. O que converte um teste é perda, e para
 * perder é preciso ter tido.
 */
export const TRIAL_MIRRORS: Exclude<PlanType, 'FREE'> = 'PRO';

export type PlanFeatureSpec = {
  /** Slug estável, igual nos quatro planos. Agrupa a tabela comparativa. */
  key: string;
  name: string;
  sortOrder: number;
  description?: string;
  /**
   * A linha aparece no **card** do plano, e não só na tabela comparativa.
   *
   * O card tem espaço para umas nove linhas antes de virar rolagem (o número
   * vive em {@link HIGHLIGHT_LIMIT}), e a tabela comparativa mostra o catálogo
   * inteiro. São perguntas diferentes: a tabela pergunta "qual é a diferença?",
   * e o card pergunta "o que eu preciso ver para decidir sem abrir a tabela?".
   *
   * **Não é `enabled` nem uma fatia de `sortOrder`.** `enabled` responde "o
   * plano inclui?", que é o que a guarda lê. E um `.slice(0, 9)` pegaria o
   * bloco de Cobertura inteiro — quotas que todo plano tem, com números
   * diferentes —, deixando o card do Individual sem uma única linha do que ele
   * *não* tem. O "–" é o que vende o plano de cima, e ele mora em
   * `creative-lab` (14), `ai-narratives` (15) e `budget-actions` (21).
   *
   * Uniforme por `key`: os três cards mostram as mesmas linhas, na mesma ordem,
   * e por isso se leem lado a lado.
   */
  highlight?: boolean;
  /**
   * Um registro por plano pago. `true`/`false` é uma feature liga/desliga; uma
   * string é um limite, e implica `enabled: true`.
   *
   * `FREE` é **derivado** de {@link TRIAL_MIRRORS} e só aparece aqui quando o
   * teste difere de propósito. Derivar em vez de repetir é o que impede a
   * matriz de divergir: mudar o PRO passa a mudar o teste junto, que é
   * exatamente a regra de produto.
   */
  byPlan: Record<Exclude<PlanType, 'FREE'>, FeatureCell> & {
    FREE?: FeatureCell;
  };
};

/** A célula de um plano, resolvendo a derivação do teste. */
export function cellFor(spec: PlanFeatureSpec, type: PlanType): FeatureCell {
  if (type === 'FREE') return spec.byPlan.FREE ?? spec.byPlan[TRIAL_MIRRORS];
  return spec.byPlan[type];
}

/**
 * Os planos que alguém pode **comprar** — os únicos entre os quais existe
 * escolha a ser feita.
 *
 * `FREE` fica de fora porque ele não é uma coluna da tabela de preços: é o
 * teste, espelha o PRO, e incluí-lo faria toda linha "parecer" diferenciada
 * (FREE vs PRO no suporte) sem separar nada que o cliente decide.
 */
const CONTRACTABLE: readonly Exclude<PlanType, 'FREE'>[] = [
  'STARTER',
  'PRO',
  'ENTERPRISE',
];

/**
 * Quantas linhas o card comporta antes de virar rolagem.
 *
 * **Passou de 8 para 9 com a geração de copy.** Não é o limite cedendo à
 * pressão de uma feature nova: é a nona linha valendo o espaço. As oito
 * anteriores se dividiam entre escala (números que todo plano tem) e as três
 * que carregam o "–" do Individual; `copy-generation` faz as duas coisas ao
 * mesmo tempo — está em todos os planos **e** os separa por volume, com três
 * números diferentes.
 *
 * `creative-analyses` também separa por volume e também está em todos, e mesmo
 * assim ficou **fora** do card: com nove linhas o card já decide sozinho, e a
 * décima passaria a competir com a tabela comparativa em vez de resumi-la.
 *
 * O limite continua existindo, e continua sendo o que impede o card de virar a
 * tabela comparativa. Uma décima linha precisa do mesmo argumento.
 */
export const HIGHLIGHT_LIMIT = 9;

/**
 * As seções da tabela comparativa, na ordem em que aparecem.
 *
 * **Derivadas de `sortOrder`, não repetidas linha a linha.** Os blocos já
 * existiam como convenção — cobertura 1–9, inteligência 10–19, ação 20–29,
 * operação 30–39, governança 40+, com folga entre eles justamente para caber
 * linha nova no meio. Anotar a seção nas trinta e uma entradas duplicaria essa
 * convenção num lugar onde ela pode discordar de si mesma: uma feature com
 * `sortOrder: 41` e `section: 'Operação'` apareceria sob Governança na tabela e
 * sob Operação em qualquer outro consumidor.
 */
export const FEATURE_SECTIONS = [
  { label: 'Cobertura', upTo: 9 },
  { label: 'Inteligência', upTo: 19 },
  { label: 'Ação na plataforma', upTo: 29 },
  { label: 'Operação', upTo: 39 },
  { label: 'Governança', upTo: Number.POSITIVE_INFINITY },
] as const;

export type FeatureSection = (typeof FEATURE_SECTIONS)[number]['label'];

/** A seção a que a linha pertence, pela faixa em que seu `sortOrder` cai. */
export function sectionFor(sortOrder: number): FeatureSection {
  const section = FEATURE_SECTIONS.find((entry) => sortOrder <= entry.upTo);

  // A última faixa é aberta, então isto não acontece — mas devolver um rótulo
  // em vez de `undefined` mantém a tabela renderizável se acontecer.
  return section?.label ?? 'Governança';
}

/**
 * A linha separa dois planos contratáveis?
 *
 * É a pergunta que decide se ela merece uma linha na tabela de preços. Compara
 * o par `(enabled, value)` já resolvido, e não a célula crua, porque é isso que
 * o cliente vê: `{ quota: 395 }` e `{ quota: 395 }` são iguais, mas também o
 * são `'13 meses'` e `{ quota: 395, display: '13 meses' }`.
 */
export function distinguishesContractablePlans(spec: PlanFeatureSpec): boolean {
  const shown = CONTRACTABLE.map((type) => {
    const cell = cellFor(spec, type);
    return `${isEnabled(cell)}|${displayOf(cell) ?? ''}`;
  });

  return new Set(shown).size > 1;
}

export type PlanSpec = {
  type: PlanType;
  name: string;
  /** Preço mensal em reais. Só comparado e exibido — a Stripe cobra pelo price. */
  amount: number;
  /** Preço anual cheio em reais, ou null se o plano não é vendido no ciclo anual. */
  amountAnnual: number | null;
  /** Preenchido apenas no FREE, que é o teste gratuito. */
  trialDays: number | null;
  /**
   * O plano **não se assina sozinho** — ele se negocia.
   *
   * É a diferença entre um preço de tabela e um piso de proposta. O Enterprise
   * tem `amount: 1497` porque a landing precisa de um número para dizer "a
   * partir de", mas ninguém paga 1497: o contrato sai do comercial, e a conta
   * nasce do lead `CLOSED_WON` — organização, assentos e cotas negociadas
   * provisionados de uma vez.
   *
   * Sem esta coluna, esse "a partir de" era lido como preço em qualquer tela
   * que fizesse `formatCurrency(plan.amount)`, e a tela de assinatura chegava a
   * abrir o formulário da Stripe para cobrar os 1497 de um plano cuja entrega
   * ninguém tinha combinado. A guarda no backend recusa essa cobrança; esta
   * coluna é o que permite o front recusá-la **antes**, sem espalhar
   * `type === 'ENTERPRISE'` por seis componentes.
   */
  contactSalesOnly?: boolean;
};

export const PLAN_SPECS: readonly PlanSpec[] = [
  {
    type: 'FREE',
    name: 'Teste Gratuito',
    amount: 0,
    amountAnnual: null,
    // O FREE é o teste: fechada a janela não há camada gratuita para onde cair.
    trialDays: 14,
  },
  {
    type: 'STARTER',
    name: 'Individual',
    amount: 147,
    amountAnnual: 1470,
    trialDays: null,
  },
  {
    type: 'PRO',
    name: 'Profissional',
    // R$ 297 precificava como ferramenta de relatório um produto que escreve em
    // mídia paga. O comparável que também executa na plataforma opera entre
    // US$ 99 e US$ 299, e o Enterprise ficava a 5x daqui — degrau que nenhuma
    // entrega justificava. A 497 a escada fica 3,4x → 3,0x.
    amount: 497,
    amountAnnual: 4970,
    trialDays: null,
  },
  {
    type: 'ENTERPRISE',
    name: 'Enterprise',
    amount: 1497,
    // Negociado: o número acima é o piso que a landing mostra como "a partir de".
    amountAnnual: null,
    trialDays: null,
    contactSalesOnly: true,
  },
];

/**
 * O plano é negociado com o comercial, e não contratado no autoatendimento?
 *
 * Pergunta feita pelas guardas de assinatura, de troca de plano e de checkout —
 * as três respondiam "não" para o Enterprise e tentavam cobrar o piso de
 * vitrine. Ela lê o catálogo em vez de comparar com `'ENTERPRISE'` porque o
 * predicado é de packaging: no dia em que um segundo plano passar a ser
 * fechado por proposta, ele muda aqui e as três guardas acompanham.
 */
export function isContactSalesPlan(type: PlanType): boolean {
  return (
    PLAN_SPECS.find((spec) => spec.type === type)?.contactSalesOnly ?? false
  );
}

/**
 * A matriz. Uma linha por feature, uma coluna por plano.
 *
 * **A linha "Organizações" voltou.** Ela tinha sido removida por vender o que o
 * schema proibia: `Organization.ownerId` era `@unique` e a segunda organização
 * era recusada em qualquer plano, Enterprise inclusive. A migração aconteceu, e
 * a nota dizia que a linha voltaria nesse dia — é este.
 */
export const PLAN_FEATURE_SPECS: readonly PlanFeatureSpec[] = [
  // ── Cobertura ────────────────────────────────────────────────────────────
  {
    key: 'ad-accounts',
    name: 'Contas de anúncios conectadas',
    sortOrder: 1,
    // Escala: a primeira pergunta de quem compara.
    highlight: true,
    byPlan: {
      STARTER: { quota: 2, display: '2' },
      PRO: { quota: 10, display: '10' },
      /**
       * Piso, não teto — o número do contrato mora em `organization_quotas`.
       *
       * `Ilimitadas` era desconto disfarçado de entrega: quem tinha 40 contas
       * pagava o mesmo que quem tinha 400, e o custo marginal não tinha teto do
       * nosso lado. Um piso publicado dá alavanca ao comercial ("50 contas é
       * outro tier") e responde "por que não o Profissional?" antes de o cliente
       * bater exatamente em 10.
       */
      ENTERPRISE: { quota: 25, display: 'Sob medida (a partir de 25)' },
    },
  },
  {
    key: 'platforms',
    name: 'Plataformas',
    sortOrder: 2,
    // Único lugar do card onde o Individual mostra cobertura menor.
    highlight: true,
    byPlan: {
      STARTER: { allow: ['META', 'GOOGLE'], display: 'Meta + Google' },
      PRO: {
        allow: ['META', 'GOOGLE', 'TIKTOK'],
        display: 'Meta + Google + TikTok',
      },
      ENTERPRISE: {
        allow: ['META', 'GOOGLE', 'TIKTOK'],
        display: 'Meta + Google + TikTok',
      },
    },
  },
  {
    key: 'monitored-ads',
    name: 'Anúncios analisados',
    sortOrder: 3,
    description:
      'Os que mais gastam na janela. Acima do teto, o anúncio continua ' +
      'sincronizado e visível — apenas não entra na análise da noite.',
    // A parede honesta do plano, segundo o próprio packaging.
    highlight: true,
    byPlan: {
      STARTER: { quota: 300, display: '300' },
      PRO: { quota: 2_000, display: '2.000' },
      ENTERPRISE: { quota: 5_000, display: 'Sob medida (a partir de 5.000)' },
    },
  },
  {
    key: 'seats',
    name: 'Usuários',
    sortOrder: 5,
    // Escala de time — decide sozinho entre Individual e Profissional.
    highlight: true,
    byPlan: {
      STARTER: '3',
      PRO: '10',
      // Casa com `PLAN_SEAT_LIMITS.ENTERPRISE`, e há teste cobrando os dois.
      ENTERPRISE: 'Sob medida (a partir de 25)',
    },
  },
  {
    key: 'organizations',
    name: 'Organizações',
    sortOrder: 6,
    description:
      'Cada uma com fronteira de dado, papéis e faturamento próprios — para ' +
      'holding, rede de franquias ou agência que separa carteiras.',
    /**
     * O diferencial exclusivo do Enterprise, e o único do card.
     *
     * Contas de anúncios resolvem "muitos clientes dentro de uma operação"; o
     * que elas não resolvem é **separar** operações: uma franqueadora não pode
     * deixar uma franquia ver o gasto da outra, e uma holding fatura por
     * unidade. Isso é organização, não conta de anúncios — e é por isso que
     * o Profissional segue em 1 sem ficar capado.
     */
    highlight: true,
    byPlan: {
      STARTER: { quota: 1, display: '1' },
      PRO: { quota: 1, display: '1' },
      ENTERPRISE: { quota: 5, display: 'Sob medida (a partir de 5)' },
    },
  },
  {
    key: 'data-history',
    name: 'Histórico de dados',
    sortOrder: 7,
    description:
      'Até onde as séries e a linha do tempo podem voltar. O dado continua ' +
      'guardado — a retenção é global —, o plano governa até onde se lê.',
    byPlan: {
      // Em dias, e não em meses, porque é assim que a guarda compara: o teto
      // vira uma data-piso, e converter "6 meses" para dias na hora da leitura
      // faria a fronteira depender do comprimento do mês corrente.
      STARTER: { quota: 90, display: '3 meses' },
      PRO: { quota: 395, display: '13 meses' },
      ENTERPRISE: { quota: 395, display: '13 meses' },
    },
  },

  // ── Inteligência ─────────────────────────────────────────────────────────
  {
    key: 'ai-score',
    name: 'AI Score por anúncio, com confiança e cobertura',
    sortOrder: 10,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'waste-detector',
    name: 'Detector de desperdício — 10 detectores',
    sortOrder: 11,
    // Nomeia o que o produto faz; sem ela o card é só números.
    highlight: true,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'opportunities',
    name: 'Oportunidades — onde escalar',
    sortOrder: 12,
    description:
      'O contraponto do detector: onde vale aumentar investimento, e não onde ' +
      'cortar.',
    /**
     * O Individual fica com a metade defensiva do motor.
     *
     * "Pare de perder dinheiro" é o que um operador solo compra; "escale o que
     * está funcionando" é problema de quem já tem verba para realocar — e essa
     * pessoa está no Profissional. Não é um motor separado: oportunidade é
     * `findingKind: 'OPPORTUNITY'` no mesmo detector, então o corte é de
     * leitura, e o achado continua sendo produzido e guardado. Quem sobe de
     * plano encontra o histórico já lá, em vez de começar do zero.
     */
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'recommendations',
    name: 'Recomendações com evidência e procedência',
    sortOrder: 13,
    byPlan: {
      STARTER: true,
      PRO: true,
      ENTERPRISE: true,
    },
  },
  {
    key: 'creative-lab',
    /**
     * O nome descreve **o que a chave governa**, não o módulo inteiro.
     *
     * Era "Creative Lab — análise por criativo", e o '–' no Individual lia-se
     * como "você não tem Creative Lab" - quando a tela, a comparação entre
     * anúncios e os candidatos de substituição estão lá, e o que falta é o
     * texto de IA por cima. A descrição já dizia isso, mas ela só aparece na
     * tabela comparativa: quem lê o card do plano via só o nome e o traço, e
     * concluía o contrário do que o produto entrega.
     *
     * A chave (`creative-lab`) fica como está - renomeá-la exigiria migrar
     * `plan_features` e reescrever `ENFORCED_FEATURE_KEYS` para consertar um
     * rótulo de vitrine.
     */
    name: 'Creative Lab — leitura com IA',
    sortOrder: 14,
    description:
      'A análise determinística sempre roda e a tela está em todos os ' +
      'planos; o que o plano governa é o enriquecimento por IA sobre ela.',
    /**
     * Liga/desliga, e não "20 por mês" como no primeiro desenho.
     *
     * O custo que uma cota aqui existiria para conter é contido pelo teto diário
     * de gasto da organização (`llmDailyBudgetBase`), que é por onde o dinheiro
     * de fato sai. Dois limites sobre o mesmo gasto divergem, e o que erra é o
     * que ninguém revisita.
     *
     * **O argumento original tinha uma segunda perna que caiu.** Ele dizia
     * também que a cota exigiria um medidor novo, com fechamento de mês e
     * conciliação. O medidor existe hoje (`organization_usage_counters`) e não
     * tem nenhum dos dois. O que sustenta a decisão é só a primeira perna — e
     * ela basta: esta linha governa *se* a IA lê, não *quantas vezes*. O quanto
     * é de `creative-analyses`, que ganhou cota própria justamente por medir
     * outra coisa.
     */
    // Primeiro '–' do Individual.
    highlight: true,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'ai-narratives',
    name: 'Narrativas geradas por IA',
    sortOrder: 15,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'measured-impact',
    name: 'Impacto medido do que foi aplicado',
    sortOrder: 16,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'copy-generation',
    name: 'Geração de copy no Creative Lab',
    sortOrder: 17,
    description:
      'A Allva transforma o que a análise recomendou mudar em três variações ' +
      'de texto, com o motivo de cada uma. O diagnóstico é determinístico e ' +
      'está em todos os planos; o que a cota governa é quantas vezes por mês a ' +
      'IA escreve.',
    /**
     * **Cota mensal, e é a primeira linha do catálogo que tem uma.**
     *
     * A decisão de `creative-lab` foi a oposta — liga/desliga, com o argumento
     * de que a cota exigiria um medidor novo e que o teto diário de LLM já
     * continha o custo. O argumento continua valendo lá, e a diferença aqui é
     * de packaging: a geração é oferecida nos três planos, e o que os separa é
     * o volume. Sem medidor, "limite menor no Individual" não existe.
     *
     * O medidor é o mais barato possível: **a própria tabela conta**. `COUNT`
     * sobre `copy_generations` do mês corrente, sem contador incremental, sem
     * fechamento de mês e sem conciliação — as três coisas que fariam a cota
     * divergir do que de fato aconteceu.
     *
     * Os dois tetos medem coisas diferentes e por isso convivem: este governa
     * **quantas vezes** a pessoa pede; `llmDailyBudgetBase` governa **quanto
     * dinheiro** sai por dia, e continua sendo a parede.
     */
    /**
     * **No card, como nona linha** — e o card passou a comportar nove.
     *
     * Nenhum destaque saiu para ela entrar, o que era a outra saída possível.
     * A razão de o limite ter subido em vez de alguém ceder o lugar está em
     * {@link HIGHLIGHT_LIMIT}: ela separa os três planos **por volume** estando
     * presente em todos eles, e as oito anteriores ou são escala pura, ou são o
     * traço do Individual.
     *
     * `creative-analyses` nasceu depois com a mesma forma e ficou de fora: nove
     * é onde o card para de resumir e começa a competir com a tabela.
     */
    highlight: true,
    byPlan: {
      STARTER: { quota: 20, display: '20 por mês' },
      PRO: { quota: 100, display: '100 por mês' },
      /**
       * Piso publicado, não teto — o número do contrato mora em
       * `organization_quotas.max_copy_generations_monthly`. Mesma disciplina de
       * `ad-accounts`: "Ilimitado" deixou de existir porque era desconto
       * disfarçado de entrega, e aqui o custo marginal é uma chamada de LLM no
       * modelo mais caro do catálogo.
       */
      ENTERPRISE: { quota: 300, display: 'Sob medida (a partir de 300)' },
    },
  },
  {
    key: 'creative-analyses',
    name: 'Análises de criativo por mês',
    sortOrder: 18,
    description:
      'Quantas vezes por mês o Creative Lab analisa um anúncio. Reabrir uma ' +
      'análise já feita não consome cota: só conta a versão nova, produzida ' +
      'quando o score ou o criativo mudaram.',
    /**
     * **A única ação por clique que não tinha parede de plano.**
     *
     * `creative-lab` (14) governa o enriquecimento por IA e é liga/desliga; a
     * análise determinística roda nos três planos, e rodava sem teto nenhum.
     *
     * O argumento que dispensou a cota lá — o teto diário de gasto já contém o
     * custo — não cobre este caso, e por duas razões. A análise do Individual
     * não chama IA nenhuma, então o teto de gasto não a enxerga; e mesmo no
     * Profissional ele mede **dinheiro por dia**, que não responde "quantas
     * análises o plano entrega". Um teto de gasto e uma cota de volume são
     * perguntas diferentes — a mesma distinção que `copy-generation` já faz.
     *
     * **Fora do card.** {@link HIGHLIGHT_LIMIT} continua em 9, e esta linha não
     * tem o argumento que a nona teve: ela não carrega o "–" do Individual,
     * porque está ligada nos três planos.
     */
    /**
     * **Os números vêm de `monitored-ads`, não da escala de `copy-generation`.**
     *
     * A primeira redação foi 100/500/2.000, copiando a forma da linha vizinha —
     * e a forma estava certa lá e errada aqui, por uma ordem de grandeza. A
     * geração de copy roteia para `claude-sonnet-5` (US$ 2/US$ 10 por milhão) e
     * produz três variações com raciocínio; a análise roteia para
     * `gpt-5.6-luna` (US$ 0,20/US$ 1,20) e produz um parágrafo medido em 382
     * tokens de entrada e 186 de saída. São **R$ 0,00165 por análise**, contra
     * algo entre 40 e 60 vezes isso na geração.
     *
     * Ao teto abaixo, a IA custa R$ 0,00 no Individual (que não a inclui), R$
     * 4,95 no Profissional e R$ 16,50 no Enterprise — menos de 1% do preço em
     * todos. Um teto de 100 não continha custo nenhum; continha o usuário.
     *
     * **O custo que justifica a parede é o banco**, não o token: cada análise
     * nova varre os criativos da conta para resolver candidatos de substituição.
     *
     * ## Por que o múltiplo sobe, e por que ele precisa subir
     *
     * Um múltiplo fixo faria esta linha ser *derivada* de `monitored-ads` — e aí
     * ela mereceria o mesmo destino de `monthly-analyses`, que saiu do catálogo
     * exatamente por publicar um número que outra linha já determinava.
     *
     * Ele sobe porque os assentos sobem: 3, 10 e 25 pessoas olhando o mesmo
     * inventário produzem mais análises **por anúncio**. O eixo é inventário ×
     * time, não inventário de novo.
     */
    byPlan: {
      // 300 anúncios monitorados × 1 análise por mês.
      STARTER: { quota: 300, display: '300 por mês' },
      // 2.000 × 1,5 — mais gente olhando o mesmo anúncio.
      PRO: { quota: 3_000, display: '3.000 por mês' },
      /**
       * 5.000 × 2, e piso publicado como em `ad-accounts` e `copy-generation`:
       * o número do contrato mora em
       * `organization_quotas.max_creative_analyses_monthly`.
       */
      ENTERPRISE: {
        quota: 10_000,
        display: 'Sob medida (a partir de 10.000)',
      },
    },
  },

  // ── Ação na plataforma ───────────────────────────────────────────────────
  {
    key: 'ad-actions',
    name: 'Ações no anúncio',
    sortOrder: 20,
    description:
      'Pausar, ativar, arquivar, duplicar e trocar criativo, copy ou CTA.',
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'budget-actions',
    name: 'Ações de orçamento, conjunto e campanha',
    sortOrder: 21,
    description:
      'Agir acima do anúncio: pausar ou reativar conjunto e campanha, e ' +
      'ajustar orçamento.',
    // Agir acima do anúncio: a parede declarada do Individual.
    highlight: true,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'batch-actions',
    name: 'Ações em lote',
    sortOrder: 22,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'revert-execution',
    name: 'Reverter uma execução',
    sortOrder: 23,
    description:
      'Onde há escrita em mídia paga, há reversão — nunca é feature paga à parte.',
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'write-consent',
    name: 'Consentimento por integração e kill switch',
    sortOrder: 24,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'action-daily-cap',
    name: 'Teto diário de ações configurável',
    sortOrder: 25,
    byPlan: { STARTER: false, PRO: false, ENTERPRISE: true },
  },

  // ── Operação ─────────────────────────────────────────────────────────────
  {
    key: 'sync-frequency',
    name: 'Sincronização',
    sortOrder: 30,
    description:
      'De quanto em quanto tempo os números da plataforma são trazidos para cá.',
    /**
     * O teto é o **intervalo em horas**, e não uma quantidade.
     *
     * A menção a "reconciliação a cada 6h" saiu do texto do Profissional de
     * propósito: reconciliação compara o observado com a nossa intenção — é ela
     * que descobre que uma pausa não pegou. Isso é **correção de dado**, não
     * feature, e ela roda para todo plano. Anunciá-la só no Profissional
     * insinuava que o Individual não a tem, o que era falso antes mesmo de
     * existir guarda: nada no código lia esta linha.
     */
    byPlan: {
      STARTER: { quota: 4, display: 'A cada 4 horas' },
      PRO: { quota: 1, display: 'De hora em hora' },
      ENTERPRISE: { quota: 1, display: 'De hora em hora' },
    },
  },
  {
    key: 'in-app-alerts',
    name: 'Alertas no app',
    sortOrder: 31,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'email-waste-alerts',
    name: 'Alertas de desperdício por email',
    sortOrder: 32,
    description:
      'Só achados de prioridade alta ou crítica viram alerta; o plano governa ' +
      'quais deles saem do app e chegam por email.',
    /**
     * Corta por **severidade**, e não por liga/desliga.
     *
     * Email é como um operador solo descobre que está queimando dinheiro —
     * removê-lo quebraria o ciclo detectar → avisar → agir, e quem perde o
     * ciclo cancela em vez de subir de plano. Deixando o crítico passar, o
     * Individual continua sendo avisado do pior, e "todos os níveis" vira uma
     * linha honesta do Profissional.
     *
     * Vale só para `WASTE_DETECTED`: alertas de integridade — integração caída,
     * quarentena de sync — chegam em qualquer plano, porque silenciar "seus
     * dados pararam de entrar" seria esconder um defeito, não vender um upgrade.
     */
    byPlan: {
      STARTER: { allow: ['CRITICAL'], display: 'Somente críticos' },
      PRO: {
        allow: ['WARNING', 'CRITICAL'],
        display: 'Todos os níveis',
      },
      ENTERPRISE: {
        allow: ['WARNING', 'CRITICAL'],
        display: 'Todos os níveis',
      },
    },
  },
  {
    key: 'daily-summary-email',
    // Deixou de ser sempre diário, então o rótulo não pode dizer que é.
    name: 'Resumo por email',
    sortOrder: 33,
    description:
      'O apanhado de desperdício aberto e recomendações novas, por email.',
    /**
     * Cadência, não liga/desliga.
     *
     * O Individual continua recebendo o apanhado — tirá-lo faria a conta ficar
     * sem nenhum resumo periódico, e quem não é lembrado do produto não sobe de
     * plano, some. Semanal preserva o hábito e deixa "todo dia de manhã" como
     * razão concreta para o Profissional.
     */
    byPlan: {
      STARTER: { allow: ['WEEKLY'], display: 'Semanal (segundas)' },
      PRO: { allow: ['DAILY'], display: 'Diário' },
      ENTERPRISE: { allow: ['DAILY'], display: 'Diário' },
    },
  },
  {
    key: 'pdf-reports',
    name: 'Relatórios em PDF',
    sortOrder: 34,
    byPlan: {
      STARTER: { allow: ['weekly-performance'], display: '1 modelo' },
      // `period-performance` entra a partir do Profissional: é o único modelo
      // que lê fundo no histórico, e o teto de histórico já é o que separa os
      // planos (`data-history`: 3 meses no Essencial, 13 no Profissional).
      // Oferecê-lo no Essencial seria vender um relatório de 12 meses a quem lê
      // 3 - a lista de períodos sairia truncada e o modelo pareceria quebrado.
      PRO: {
        allow: [
          'weekly-performance',
          'creative-analysis',
          'waste-report',
          'executive-summary',
          'period-performance',
        ],
        display: '5 modelos',
      },
      ENTERPRISE: {
        allow: [
          'weekly-performance',
          'creative-analysis',
          'waste-report',
          'executive-summary',
          'period-performance',
        ],
        display: '5 modelos',
      },
    },
  },
  {
    key: 'report-email',
    name: 'Enviar relatório por email',
    sortOrder: 35,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },

  // ── Governança ───────────────────────────────────────────────────────────
  {
    key: 'rbac',
    name: 'Papéis e permissões — 6 papéis',
    sortOrder: 40,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'audit-trail',
    name: 'Trilha de auditoria',
    sortOrder: 41,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'base-currency',
    name: 'Moeda-base por organização',
    sortOrder: 42,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'detector-calibration',
    name: 'Calibração de detectores e janela de scoring',
    sortOrder: 43,
    byPlan: { STARTER: false, PRO: false, ENTERPRISE: true },
  },
  {
    key: 'ai-daily-budget',
    name: 'Teto diário de custo de IA',
    sortOrder: 44,
    byPlan: { STARTER: false, PRO: false, ENTERPRISE: true },
  },
  {
    key: 'support',
    name: 'Suporte',
    sortOrder: 45,
    byPlan: {
      // A única linha em que o teste difere do PRO de propósito: prioridade de
      // atendimento é promessa comercial, não capacidade de produto.
      FREE: 'Email',
      STARTER: 'Email',
      PRO: 'Email prioritário',
      ENTERPRISE: 'Onboarding + canal dedicado',
    },
  },
  /**
   * A mesma promessa de `support`, quebrada em quatro capacidades booleanas.
   *
   * `support` é prosa de vitrine — "Email prioritário" não tem onde incidir num
   * `if`. Estas quatro linhas existem para o Drawer de suporte do frontend
   * poder perguntar "esta organização tem X?" sem parsear a prosa: cada uma
   * projeta em `plan_features.enabled`, e as quatro entram em
   * `ENFORCED_FEATURE_KEYS`: `support-email` guarda
   * `POST /api/v1/support/messages`, `support-priority` decide a prioridade
   * gravada no chamado, e `support-dedicated-channel`/`support-onboarding`
   * guardam as leituras da Central de suporte — a tela que o Enterprise
   * compra quando compra "canal dedicado".
   *
   * Sem `FREE` explícito: o teste espelha o PRO por padrão (`cellFor`), e aqui
   * isso é a resposta certa — quem está testando o produto vê o mesmo suporte
   * de quem já paga o Profissional.
   */
  {
    key: 'support-email',
    name: 'Suporte por e-mail',
    sortOrder: 46,
    byPlan: { STARTER: true, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'support-priority',
    name: 'Prioridade de atendimento',
    sortOrder: 47,
    byPlan: { STARTER: false, PRO: true, ENTERPRISE: true },
  },
  {
    key: 'support-dedicated-channel',
    name: 'Canal de suporte dedicado',
    sortOrder: 48,
    byPlan: { STARTER: false, PRO: false, ENTERPRISE: true },
  },
  {
    key: 'support-onboarding',
    name: 'Onboarding assistido',
    sortOrder: 49,
    byPlan: { STARTER: false, PRO: false, ENTERPRISE: true },
  },
];

/** A linha de `plan_features` que um par (feature, plano) produz. */
export type ResolvedPlanFeature = {
  key: string;
  name: string;
  enabled: boolean;
  value: string | null;
  description: string | null;
  sortOrder: number;
  /**
   * A linha entra no card do plano. Uniforme entre os quatro planos — os cards
   * mostram as mesmas linhas na mesma ordem, e destaque por plano produziria
   * uma linha existindo na coluna de um e faltando na do vizinho.
   *
   * Nomeado como a coluna, e não como `PlanFeatureSpec.highlight`: esta é a
   * linha projetada, e quem a consome escreve direto no banco. Um nome curto
   * aqui obrigaria seed e repositório a traduzir, que é onde um campo novo
   * costuma ser esquecido.
   */
  landingHighlight: boolean;
  /** A seção da tabela comparativa, derivada de `sortOrder`. */
  section: FeatureSection;
};

/**
 * Projeta o catálogo nas linhas de um plano.
 *
 * Uma string vira `enabled: true` com o limite em `value`: "300 anúncios" é uma
 * feature presente com teto, não uma feature desligada — e tratá-la como
 * booleana é o que faria a landing sumir com a linha inteira.
 */
export function resolvePlanFeatures(type: PlanType): ResolvedPlanFeature[] {
  return PLAN_FEATURE_SPECS.map((spec) => {
    const cell = cellFor(spec, type);

    return {
      key: spec.key,
      name: spec.name,
      enabled: isEnabled(cell),
      value: displayOf(cell),
      description: spec.description ?? null,
      sortOrder: spec.sortOrder,
      landingHighlight: spec.highlight ?? false,
      section: sectionFor(spec.sortOrder),
    };
  });
}

/** As linhas que o card do plano mostra, na ordem do catálogo. */
export function highlightPlanFeatures(type: PlanType): ResolvedPlanFeature[] {
  return resolvePlanFeatures(type)
    .filter((feature) => feature.landingHighlight)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Um teto de `0` e uma lista vazia **desligam** a feature.
 *
 * É o que permite "Individual não tem TikTok" e "Individual não tem narrativas"
 * serem a mesma pergunta para a guarda, em vez de duas — a vitrine mostra um
 * traço nos dois casos, e a decisão é uma só.
 */
function isEnabled(cell: FeatureCell): boolean {
  if (cell === false) return false;
  if (typeof cell === 'object' && 'quota' in cell) return cell.quota !== 0;
  if (typeof cell === 'object' && 'allow' in cell) return cell.allow.length > 0;
  return true;
}

function displayOf(cell: FeatureCell): string | null {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'object') return cell.display;
  return null;
}
