/**
 * O **catálogo público** de achados (§10.5) — contrato, não cálculo.
 *
 * Quais tipos existem, qual é desperdício e qual é oportunidade, em que escopo
 * cada um é calculado e que recomendação cada um origina. `recommendations`
 * (A2-S6) precisa disso para mapear achado → remédio sem importar um único
 * detector; `alerts` precisa da prioridade para decidir se notifica.
 *
 * A fronteira é a mesma que `ad-scoring` estabeleceu em A2-S4: **o que o achado
 * é** mora em `contracts/`, **como ele é detectado** mora em `detectors/`, e o
 * teste de arquitetura recusa quem atravessar.
 */

export type FindingType =
  | 'ZERO_CONVERSIONS'
  | 'LOW_ROAS'
  | 'HIGH_CPA'
  | 'LOW_CTR'
  | 'CREATIVE_FATIGUE'
  | 'NEGATIVE_FEEDBACK'
  | 'LEARNING_INSTABILITY'
  | 'AUDIENCE_SATURATION'
  | 'OVERLAPPING_DELIVERY'
  | 'BUDGET_STARVATION';

/**
 * §10.2 — os dois **jamais** se misturam em agregados.
 *
 * Um anúncio saudável sufocado por orçamento é dinheiro que deixou de ser
 * ganho, não gasto mal. A separação é garantida pela view `open_waste`, não pela
 * disciplina de quem escreve a consulta; este mapa é o que a alimenta.
 */
export type FindingKind = 'WASTE' | 'OPPORTUNITY';

/** Onde o detector opera. A família `AD_SET` devolve achados já atribuídos. */
export type DetectorScope = 'AD' | 'AD_SET';

/**
 * Onde o fenômeno foi **calculado de fato** (§3.4).
 *
 * Diferente de `DetectorScope`: um detector de escopo `AD` que caiu para a linha
 * de base da conta calculou o benchmark em `AD_ACCOUNT`, e é isso que
 * `evidence.scopeLevel` declara. Fundir os dois esconderia justamente a queda
 * que DEC-3 obriga a declarar.
 */
export type ScopeLevel = 'AD' | 'AD_SET' | 'CAMPAIGN' | 'AD_ACCOUNT';

export type WastePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type WasteResolutionKind =
  | 'RESOLVED_BY_ACTION'
  | 'RESOLVED_EXTERNALLY'
  | 'RESOLVED_BY_RESTATEMENT'
  | 'DISMISSED'
  | 'STALE'
  | 'SUPERSEDED_BY_DETECTOR';

export const FINDING_TYPES: readonly FindingType[] = [
  'ZERO_CONVERSIONS',
  'LOW_ROAS',
  'HIGH_CPA',
  'LOW_CTR',
  'CREATIVE_FATIGUE',
  'NEGATIVE_FEEDBACK',
  'LEARNING_INSTABILITY',
  'AUDIENCE_SATURATION',
  'OVERLAPPING_DELIVERY',
  'BUDGET_STARVATION',
];

/**
 * `BUDGET_STARVATION` é o único `OPPORTUNITY`, e a exceção é o ponto: ele não
 * tem `incurredAmount` porque não há gasto errado a contabilizar — há ganho que
 * não aconteceu. Somá-lo ao desperdício inflaria o número de capa com dinheiro
 * que nunca saiu da conta.
 */
export const FINDING_KIND: Readonly<Record<FindingType, FindingKind>> = {
  ZERO_CONVERSIONS: 'WASTE',
  LOW_ROAS: 'WASTE',
  HIGH_CPA: 'WASTE',
  LOW_CTR: 'WASTE',
  CREATIVE_FATIGUE: 'WASTE',
  NEGATIVE_FEEDBACK: 'WASTE',
  LEARNING_INSTABILITY: 'WASTE',
  AUDIENCE_SATURATION: 'WASTE',
  OVERLAPPING_DELIVERY: 'WASTE',
  BUDGET_STARVATION: 'OPPORTUNITY',
};

/**
 * A recomendação que cada achado origina (§10.5, coluna final).
 *
 * *"Nenhum tipo fica órfão."* `EXPAND_AUDIENCE` é consultiva — expandir público
 * está fora do escopo permanente da Allva —, e é por isso que o mapa aponta para
 * ela em vez de omitir `AUDIENCE_SATURATION`: esconder o diagnóstico porque não
 * temos a ação seria pior que declarar que a ação é do usuário.
 */
export const RECOMMENDATION_BY_FINDING: Readonly<Record<FindingType, string>> =
  {
    ZERO_CONVERSIONS: 'PAUSE_UNDERPERFORMING_AD',
    LOW_ROAS: 'PAUSE_UNDERPERFORMING_AD',
    HIGH_CPA: 'REDUCE_BUDGET_HIGH_CPA',
    LOW_CTR: 'IMPROVE_WEAK_HOOK',
    CREATIVE_FATIGUE: 'REFRESH_FATIGUED_CREATIVE',
    NEGATIVE_FEEDBACK: 'MITIGATE_NEGATIVE_FEEDBACK',
    LEARNING_INSTABILITY: 'STABILIZE_LEARNING',
    AUDIENCE_SATURATION: 'EXPAND_AUDIENCE',
    OVERLAPPING_DELIVERY: 'CONSOLIDATE_OVERLAP',
    BUDGET_STARVATION: 'SCALE_WINNING_AD',
  };

/**
 * O nome de cada achado **em português**, para o texto que sai do produto.
 *
 * Mora no catálogo porque é contrato: `OVERLAPPING_DELIVERY` é o identificador
 * que atravessa fingerprint, filtro e API, e nunca deveria chegar ao usuário —
 * o alerta e o e-mail que interpolavam o enum cru pediam a ele que adivinhasse
 * o que "entrega sobreposta" significa a partir de uma constante de código.
 *
 * Os rótulos são os mesmos que a tela de Desperdícios já mostra: um alerta que
 * inventasse vocabulário próprio obrigaria a traduzir duas vezes o mesmo achado.
 */
export const FINDING_LABEL: Readonly<Record<FindingType, string>> = {
  ZERO_CONVERSIONS: 'Sem conversões',
  LOW_ROAS: 'ROAS baixo',
  HIGH_CPA: 'CPA alto',
  LOW_CTR: 'CTR baixo',
  CREATIVE_FATIGUE: 'Fadiga de criativo',
  NEGATIVE_FEEDBACK: 'Feedback negativo',
  LEARNING_INSTABILITY: 'Instabilidade de aprendizado',
  AUDIENCE_SATURATION: 'Saturação de audiência',
  OVERLAPPING_DELIVERY: 'Entrega sobreposta',
  BUDGET_STARVATION: 'Orçamento subutilizado',
};

/**
 * §10.3 — a família relacional.
 *
 * Os dois detectores de conjunto avaliam o ad set inteiro e devolvem achados
 * **já atribuídos** a anúncios específicos. Sem atribuição determinística o
 * fingerprint muda entre execuções, a deduplicação quebra, e o mesmo problema
 * reaparece como item novo todo dia.
 */
export const AD_SET_SCOPED_FINDINGS: readonly FindingType[] = [
  'AUDIENCE_SATURATION',
  'OVERLAPPING_DELIVERY',
];

export function scopeOf(type: FindingType): DetectorScope {
  return AD_SET_SCOPED_FINDINGS.includes(type) ? 'AD_SET' : 'AD';
}

/**
 * O rótulo de um tipo que chega como `string` — os eventos de domínio carregam
 * `type: string`, não `FindingType`.
 *
 * Um detector novo cujo rótulo ainda não foi escrito cai no código cru, que é
 * feio mas verdadeiro; inventar "Desconhecido" aqui esconderia de quem programa
 * exatamente o esquecimento que precisa ser corrigido.
 */
export function findingLabel(type: string): string {
  return FINDING_LABEL[type as FindingType] ?? type;
}
