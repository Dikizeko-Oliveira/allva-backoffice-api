/**
 * Maturidade do dado (§8.9).
 *
 * As plataformas reescrevem o passado. Conversão chega atribuída a dias
 * anteriores, gasto sofre ajuste por tráfego inválido, receita chega atrasada.
 * Um número lido hoje sobre ontem **vai mudar** — e decidir sobre ele é como o
 * produto recomenda pausar um anúncio que converteu.
 *
 * ```text
 * maturidade(dia D) = hoje − D  contra a janela de atribuição da CONTA
 *   IMMATURE   dentro da janela          → métricas ainda vão mudar
 *   SETTLING   até 2× a janela           → mudanças residuais
 *   MATURE     além disso                → estável para decisão
 * ```
 *
 * A janela é **da conta** e não da organização (§8.2): duas contas da mesma
 * organização podem atribuir em 7 e em 28 dias, e tratá-las igual faria a de 28
 * perder conversão retroativa sistematicamente — sempre nas mesmas condições, o
 * que é indistinguível de desempenho ruim.
 */

export type DataMaturity = 'IMMATURE' | 'SETTLING' | 'MATURE';

/** Janela de atribuição padrão quando a plataforma não a expõe. */
export const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Meia-noite UTC do dia de uma data — comparação de dias, não de instantes. */
export function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Dias inteiros entre dois dias UTC. Negativo se `date` for futuro. */
export function daysBetween(date: Date, reference: Date): number {
  return Math.floor(
    (utcDay(reference).getTime() - utcDay(date).getTime()) / MS_PER_DAY,
  );
}

/**
 * A maturidade de **um dia** da série.
 *
 * Data futura (fuso da conta à frente do UTC, relógio da plataforma adiantado)
 * é tratada como idade zero: `IMMATURE`. O erro cai do lado certo — na dúvida,
 * o dado ainda vai mudar.
 */
export function maturityOfDay(
  date: Date,
  now: Date,
  attributionWindowDays: number = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
): DataMaturity {
  const window = Math.max(1, attributionWindowDays);
  const age = Math.max(0, daysBetween(date, now));

  if (age < window) return 'IMMATURE';
  if (age < window * 2) return 'SETTLING';
  return 'MATURE';
}

/**
 * A maturidade de uma **janela** é a do seu dia menos maduro — que é sempre o
 * mais recente.
 *
 * É por isso que `Ad.dataMaturity` (denormalizada pelo ingest, §5.4) e o gate
 * dos detectores usam a mesma função: "o dado mais novo do anúncio ainda está
 * se movendo" e "esta janela ainda não assentou" são a mesma afirmação.
 *
 * Sem nenhum dia observado devolve `null` — não há maturidade a declarar sobre
 * ausência de dado, e `IMMATURE` mentiria dizendo que existe algo se assentando.
 */
export function maturityOfWindow(
  days: Date[],
  now: Date,
  attributionWindowDays: number = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
): DataMaturity | null {
  if (days.length === 0) return null;

  const newest = days.reduce((latest, day) => (day > latest ? day : latest));
  return maturityOfDay(newest, now, attributionWindowDays);
}

/**
 * A tabela de §8.9 como **dado**, não como comentário.
 *
 * Os três detectores que dependem de conversão só rodam sobre janela `MATURE`;
 * os que dependem de impressão e clique podem usar `SETTLING`, porque impressão
 * não é re-declarada. `ZERO_CONVERSIONS` origina `PAUSE_UNDERPERFORMING_AD`, a
 * ação mais destrutiva do catálogo — disparar sobre dado imaturo é recomendar
 * pausar anúncio que converteu, e o usuário descobre isso na plataforma.
 *
 * A2-S5 lê este mapa ao montar os detectores. Ele mora aqui porque a maturidade
 * é propriedade da observação, e observação é do `sync`.
 */
export const MINIMUM_MATURITY_BY_FINDING: Readonly<
  Record<string, DataMaturity>
> = {
  ZERO_CONVERSIONS: 'MATURE',
  LOW_ROAS: 'MATURE',
  HIGH_CPA: 'MATURE',
  LOW_CTR: 'SETTLING',
  CREATIVE_FATIGUE: 'SETTLING',
  NEGATIVE_FEEDBACK: 'SETTLING',
};

const MATURITY_RANK: Record<DataMaturity, number> = {
  IMMATURE: 0,
  SETTLING: 1,
  MATURE: 2,
};

/**
 * Quantos dias a janela julgada precisa **terminar antes de hoje** para nascer
 * com a maturidade exigida.
 *
 * É a correção do defeito central de §8.9: a maturidade era lida de um campo
 * único por anúncio, derivado do dia mais novo da série inteira. Num anúncio que
 * entrega todo dia esse dia é sempre ontem, então o campo ficava preso em
 * `IMMATURE` **para sempre** — e os seis achados que exigem `SETTLING` ou
 * `MATURE` nunca disparavam em anúncio ativo, que é justamente o único sobre o
 * qual há desperdício a evitar.
 *
 * A pergunta certa não é "o dado mais novo deste anúncio já assentou?" e sim
 * "a janela que estou julgando já assentou?". Recuar o fim da janela pela
 * atribuição da conta responde a segunda, e ela tem resposta útil com o anúncio
 * rodando.
 *
 * **O preço é declarado:** um achado que exige `MATURE` passa a falar de um
 * período que terminou há duas janelas de atribuição. É a mesma defasagem que a
 * regra de atribuição sempre impôs — a versão anterior não a eliminou, apenas a
 * transformou em silêncio permanente.
 */
export function maturityLagDays(
  required: DataMaturity,
  attributionWindowDays: number = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
): number {
  const window = Math.max(1, attributionWindowDays);
  return MATURITY_RANK[required] * window;
}

/** `true` quando a janela observada satisfaz a maturidade mínima exigida. */
export function satisfiesMaturity(
  observed: DataMaturity | null,
  required: DataMaturity,
): boolean {
  if (!observed) return false;
  return MATURITY_RANK[observed] >= MATURITY_RANK[required];
}

/**
 * A janela de re-declaração da conta: `max(env, janela de atribuição)`.
 *
 * Nunca menor que a atribuição — re-buscar 7 dias numa conta que atribui em 28
 * perde conversão retroativa por construção, e o produto reportaria queda de
 * performance que só existe porque parou de olhar cedo demais.
 */
export function restatementWindowDaysFor(input: {
  attributionWindowDays: number | null;
  envMinimumDays: number;
}): number {
  return Math.max(
    input.envMinimumDays,
    input.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  );
}
