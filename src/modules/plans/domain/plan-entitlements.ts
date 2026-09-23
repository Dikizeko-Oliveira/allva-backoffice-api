import {
  PLAN_FEATURE_SPECS,
  PLAN_SPECS,
  type PlanType,
  cellFor,
  resolvePlanFeatures,
} from './plan-catalog';

/**
 * O que uma guarda pode perguntar ao plano — **derivado do mesmo catálogo que a
 * landing mostra**.
 *
 * É a peça que faltava para o packaging deixar de ser vitrine. Antes, o único
 * teto de fato aplicado no sistema era o de assentos: a página de preços
 * prometia treze linhas por plano e o produto entregava as treze a todo mundo.
 * Uma constante paralela aqui teria o mesmo destino — divergir da vitrine no
 * primeiro ajuste, e divergir em silêncio, porque nada compara as duas.
 * Derivando de `PLAN_FEATURE_SPECS`, mudar o catálogo muda a guarda junto.
 *
 * ## Só um subconjunto é aplicável
 *
 * A maioria das 32 linhas do catálogo é vitrine e continua sendo: "13 meses de
 * histórico" ou "suporte prioritário" não têm onde incidir num `if`. As chaves
 * abaixo são as que **de fato** governam uma decisão em tempo de requisição, e
 * a lista é explícita justamente para que ninguém confunda "está no catálogo"
 * com "está aplicado".
 */
export const ENFORCED_FEATURE_KEYS = [
  'ad-actions',
  'budget-actions',
  'batch-actions',
  'ad-accounts',
  'platforms',
  'pdf-reports',
  'monitored-ads',
  'ai-narratives',
  'creative-lab',
  // Cota **mensal**, contada pela própria `copy_generations`. A razão de haver
  // um teto por mês aqui está na declaração da linha.
  'copy-generation',
  // A outra cota mensal, contada pela própria `creative_analyses`. Só a versão
  // nova consome — o reuso de P9 não produz nada e não é cobrado.
  'creative-analyses',
  'data-history',
  // Leitura, não escrita: o achado de oportunidade continua sendo produzido e
  // guardado — o plano governa quem consegue lê-lo. Apagar por plano faria quem
  // sobe de plano começar do zero, em vez de encontrar o histórico já lá.
  'opportunities',
  // Subconjunto de severidades, não liga/desliga — ver a linha no catálogo.
  'email-waste-alerts',
  // Cadência do resumo por email: diária ou semanal.
  'daily-summary-email',
  // Intervalo entre ingestões, em horas.
  'sync-frequency',
  // Quantas organizações uma conta pode possuir.
  'organizations',
  // `POST /api/v1/support/messages` recusa sem ela.
  'support-email',
  // Decide a `priority` gravada no chamado na criação (HIGH quando o plano
  // inclui, MEDIUM quando não) e o teto da prioridade que o solicitante pode
  // declarar — ver `SendSupportMessageUseCase.resolvePriority`.
  'support-priority',
  // As duas deixaram de ser vitrine quando a Central de suporte
  // (`/account/support/*`) passou a existir: `GET /support/tickets` e
  // `/tickets/:code` recusam sem a primeira, `GET /support/onboarding` sem a
  // segunda. Duas chaves e não uma porque é assim que o catálogo as vende —
  // "Canal de suporte dedicado" e "Onboarding assistido" coincidem no
  // Enterprise hoje, e nada garante que coincidam no próximo pacote.
  'support-dedicated-channel',
  'support-onboarding',
] as const;

export type EnforcedFeatureKey = (typeof ENFORCED_FEATURE_KEYS)[number];

/**
 * Toda linha com teto numérico. Hoje **é** `EnforcedFeatureKey`, e o alias
 * existe para dizer isso em voz alta.
 *
 * Houve um `MEASURED_FEATURE_KEYS` aqui, com uma chave só: `monthly-analyses`
 * publicava um teto e não recusava nada. Ela saiu do catálogo, e com ela a
 * categoria — porque a categoria era a exceção, não uma segunda espécie. O
 * alias fica para que o dia em que alguém precisar de uma linha medida-e-não-
 * aplicada tenha um lugar para declará-la, em vez de afrouxar
 * `ENFORCED_FEATURE_KEYS` e devolver à lista a ambiguidade que ela remove.
 */
export type QuotaFeatureKey = EnforcedFeatureKey;

/**
 * O veredito comercial, já resolvido contra o catálogo.
 *
 * Vive aqui e não em quem consome porque três módulos o consomem — a superfície
 * de escrita, as integrações e os relatórios — e o tipo pertence a quem sabe o
 * que é um plano. Carrega os rótulos prontos para que o domínio de cada
 * consumidor julgue sem precisar consultar catálogo nenhum.
 */
export type PlanEntitlementState =
  | { allowed: true }
  | {
      allowed: false;
      /** Nome comercial do plano vigente, para a recusa dizer o que se tem. */
      planLabel: string;
      /** Rótulo da linha do catálogo, para dizer o que falta. */
      featureLabel: string;
      /** O plano contratável mais barato que inclui — para onde apontar. */
      upgradeTo: string | null;
      /** Teto e uso, quando a recusa é por quantidade e não por capacidade. */
      quota?: { limit: number; used: number };
    };

/** `planType → chaves habilitadas`, montado uma vez a partir do catálogo. */
const ENABLED_BY_PLAN: ReadonlyMap<PlanType, ReadonlySet<string>> = new Map(
  PLAN_SPECS.map((plan) => [
    plan.type,
    new Set(
      resolvePlanFeatures(plan.type)
        .filter((feature) => feature.enabled)
        .map((feature) => feature.key),
    ) as ReadonlySet<string>,
  ]),
);

/**
 * O plano inclui esta capacidade?
 *
 * **Fecha na dúvida.** Um plano irresolúvel devolve `false`, ao contrário de
 * `resolveSeatLimit`, que abre. A assimetria é deliberada e vem do que está do
 * outro lado da decisão: recusar um convite legítimo é um atrito que o usuário
 * relata em minutos; deixar passar uma escrita em mídia paga move dinheiro real
 * na conta de alguém, e ninguém relata o que funcionou. De todo modo o caso é
 * teórico — a superfície de escrita exige `ALLOWED`, e `ALLOWED` exige uma
 * assinatura com plano.
 */
export function planAllows(
  planType: PlanType | null | undefined,
  key: EnforcedFeatureKey,
): boolean {
  if (!planType) return false;
  return ENABLED_BY_PLAN.get(planType)?.has(key) ?? false;
}

/** O rótulo da feature no catálogo — o texto que a recusa mostra ao usuário. */
export function featureLabel(key: QuotaFeatureKey): string {
  return PLAN_FEATURE_SPECS.find((spec) => spec.key === key)?.name ?? key;
}

/** O nome comercial do plano, para a recusa nomear o que a organização tem. */
export function planLabel(planType: PlanType | null | undefined): string {
  return PLAN_SPECS.find((plan) => plan.type === planType)?.name ?? 'atual';
}

/**
 * O plano **contratável** mais barato que inclui a capacidade — para onde a
 * recusa aponta.
 *
 * `FREE` fica de fora: ele custa zero e, desde que o teste passou a espelhar o
 * PRO, inclui quase tudo — seria sempre o mais barato da lista e a recusa
 * mandaria o usuário "fazer upgrade para o Teste Gratuito", que é justamente o
 * que ele acabou de perder.
 */
export function cheapestPlanWith(key: EnforcedFeatureKey): string | null {
  const upgrade = PLAN_SPECS.filter((plan) => plan.type !== 'FREE')
    .sort((a, b) => a.amount - b.amount)
    .find((plan) => planAllows(plan.type, key));

  return upgrade?.name ?? null;
}

/**
 * O teto numérico do plano para esta feature.
 *
 * `null` é **ilimitado** e `undefined` é "esta linha não tem teto numérico" —
 * duas coisas diferentes que um `number | null` sozinho não distingue, e
 * confundi-las faria uma linha mal modelada passar como ilimitada.
 *
 * Fecha na dúvida pela mesma razão de `planAllows`: sem plano resolvível, o teto
 * é zero.
 */
export function planQuota(
  planType: PlanType | null | undefined,
  key: QuotaFeatureKey,
): number | null | undefined {
  const spec = PLAN_FEATURE_SPECS.find((entry) => entry.key === key);
  if (!spec) return undefined;
  if (!planType) return 0;

  const cell = cellFor(spec, planType);
  if (typeof cell === 'object' && 'quota' in cell) return cell.quota;

  return undefined;
}

/**
 * O subconjunto que o plano libera — plataformas, modelos de relatório.
 *
 * Lista vazia é "nenhum", e `undefined` é "esta linha não é um subconjunto".
 */
export function planAllowList(
  planType: PlanType | null | undefined,
  key: EnforcedFeatureKey,
): readonly string[] | undefined {
  const spec = PLAN_FEATURE_SPECS.find((entry) => entry.key === key);
  if (!spec) return undefined;
  if (!planType) return [];

  const cell = cellFor(spec, planType);
  if (typeof cell === 'object' && 'allow' in cell) return cell.allow;

  return undefined;
}

/** `true` quando o item pedido está no subconjunto que o plano libera. */
export function planAllowsItem(
  planType: PlanType | null | undefined,
  key: EnforcedFeatureKey,
  item: string,
): boolean {
  return planAllowList(planType, key)?.includes(item) ?? false;
}

/**
 * O plano contratável mais barato que oferece **mais** do que o teto atual.
 *
 * `cheapestPlanWith` responde outra pergunta — "quem inclui esta capacidade?" —
 * e para uma linha com teto ela responde errado: toda linha de quota está
 * "incluída" em todo plano, então a resposta era sempre o mais barato da lista.
 * Quem batia no teto de 10 contas do Profissional era mandado **contratar o
 * Individual**, que tem 2.
 *
 * Comparar tetos é o que torna a recusa acionável: só interessa o plano que
 * resolve o problema de quem a recebeu. `null` significa que nenhum resolve — o
 * Enterprise no topo —, e aí a recusa manda falar com o comercial, que é
 * exatamente o caminho certo para renegociar contrato.
 */
export function cheapestPlanAbove(
  key: EnforcedFeatureKey,
  currentLimit: number | null,
): string | null {
  // Sem teto atual já é o máximo: não há para onde subir.
  if (currentLimit === null) return null;

  const upgrade = PLAN_SPECS.filter((plan) => plan.type !== 'FREE')
    .sort((a, b) => a.amount - b.amount)
    .find((plan) => {
      const quota = planQuota(plan.type, key);
      if (quota === undefined) return false;

      return quota === null || quota > currentLimit;
    });

  return upgrade?.name ?? null;
}

/**
 * O teto que vale de fato: o negociado, se houver; senão o do plano.
 *
 * Pura de propósito. `PlanEntitlementService` responde a mesma pergunta com as
 * portas em mãos, e `OrganizationLimitService` precisa dela sem poder importar
 * o módulo de planos — `PlansModule` já importa `OrganizationsModule`, e a volta
 * fecharia um ciclo. Uma função pura atravessa a fronteira que a injeção não
 * atravessa, e mantém a regra num lugar só.
 *
 * `null` é **sem teto nesta linha** — nunca "ilimitado", que deixou de existir.
 */
export function effectiveQuota(
  planType: PlanType | null | undefined,
  key: QuotaFeatureKey,
  negotiated: number | null,
): number | null {
  if (negotiated !== null) return negotiated;

  const fromPlan = planQuota(planType, key);

  return fromPlan === undefined ? null : fromPlan;
}

/**
 * O veredito de uma linha com teto, contra o uso atual.
 *
 * O `>=` é deliberado: `used` é o uso **antes** de adicionar mais um, e quem
 * está exatamente no teto não pode adicionar.
 */
export function quotaStateFrom(input: {
  planType: PlanType | null | undefined;
  feature: EnforcedFeatureKey;
  used: number;
  limit: number | null;
}): PlanEntitlementState {
  if (input.limit === null) return { allowed: true };
  if (input.used < input.limit) return { allowed: true };

  return {
    allowed: false,
    planLabel: planLabel(input.planType),
    featureLabel: featureLabel(input.feature),
    // Aponta para quem oferece MAIS, não para quem meramente inclui.
    upgradeTo: cheapestPlanAbove(input.feature, input.limit),
    quota: { limit: input.limit, used: input.used },
  };
}

/**
 * O teto numérico lido como **limite**, com plano irresolúvel significando
 * "sem limite".
 *
 * Existe porque `planQuota` fecha na dúvida — devolve `0` sem plano —, e isso é
 * certo para quem pergunta antes de escrever em mídia paga. Para quem pergunta
 * antes de **ler**, o mesmo `0` é desastroso: significaria "não analise nada
 * desta organização" ou "não mostre nenhum histórico", e o produto reportaria a
 * própria cegueira como fato sobre a mídia do cliente.
 *
 * Dois consumidores caíram nessa armadilha antes de ela ter nome — a régua
 * noturna de anúncios e o piso de histórico. Ter um helper é o que impede o
 * terceiro.
 */
export function planLimitOrUnlimited(
  planType: PlanType | null | undefined,
  key: QuotaFeatureKey,
): number | null {
  if (!planType) return null;

  const quota = planQuota(planType, key);
  return quota === undefined ? null : quota;
}

/**
 * A data mais antiga que uma organização pode **ler**.
 *
 * O dado não é apagado: a retenção é global (13 meses de métricas e scores), e
 * o plano governa até onde a leitura alcança. Apagar por plano seria
 * irreversível — quem voltasse ao Profissional não recuperaria o histórico que
 * comprou de volta.
 *
 * `null` significa "sem piso": plano ilimitado, ou linha sem teto declarado.
 */
/** Com que frequência o plano recebe o resumo por email. */
export type SummaryCadence = 'DAILY' | 'WEEKLY';

/**
 * A cadência do resumo, lida do mesmo catálogo que a landing mostra.
 *
 * **Fecha na dúvida, para `WEEKLY`.** Um plano irresolúvel errar para o lado
 * diário significaria entregar a cadência paga de graça, e todo dia — o erro se
 * repete e ninguém reclama de receber email demais. Semanal degrada o serviço
 * sem dar nada de graça, e o caso é teórico: organização provisionada carrega
 * plano.
 */
export function summaryCadence(
  planType: PlanType | null | undefined,
): SummaryCadence {
  const allowed = planAllowList(planType, 'daily-summary-email') ?? [];

  return allowed.includes('DAILY') ? 'DAILY' : 'WEEKLY';
}

/**
 * Intervalo mínimo, em horas, entre duas ingestões da mesma conta de anúncios.
 *
 * **Abre na dúvida, para 1h**, ao contrário de `summaryCadence`. A assimetria
 * vem do que está do outro lado: resumo a mais é um email; ingestão a menos é o
 * produto reportando números velhos como se fossem os de agora, e o cliente
 * decidindo sobre mídia paga com base neles. Sincronizar demais custa cota de
 * API; sincronizar de menos custa a confiança no número.
 */
export function syncIntervalHours(
  planType: PlanType | null | undefined,
): number {
  const quota = planQuota(planType, 'sync-frequency');

  return typeof quota === 'number' && quota > 0 ? quota : 1;
}

export function historyFloor(
  planType: PlanType | null | undefined,
  now: Date = new Date(),
): Date | null {
  const days = planLimitOrUnlimited(planType, 'data-history');
  if (days === null) return null;

  const floor = new Date(now);
  floor.setUTCDate(floor.getUTCDate() - days);

  return floor;
}
