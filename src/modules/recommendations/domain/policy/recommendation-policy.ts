import { judgesConversion } from 'src/modules/integrations/domain/entities/optimization-target';
import {
  findingLabel,
  type WastePriority,
} from 'src/modules/waste/domain/contracts/finding-catalog';
import {
  ACTION_PLAN_BY_KIND,
  IMPACT_TYPE_BY_KIND,
  PRIMARY_IMPACT_BY_KIND,
  isAdvisoryKind,
  kindForFinding,
  type RecommendationKind,
  type RecommendationPriority,
} from '../contracts/recommendation-catalog';
import { resolveAction, type BudgetIntent } from '../action-level';
import type {
  AdSignal,
  FindingSignal,
  RecommendationPlan,
  RecommendationSignals,
} from '../recommendation-plan';
import { evaluateScaleGuards } from './scale-guards';

/**
 * `RecommendationPolicy` — **domínio puro** (§9.4 passo 3b).
 *
 * Sinais entram, planos saem. Sem repositório, sem relógio interno, sem IA: o
 * enriquecimento de §9.4 passo 9 acrescenta `title` e `rationale` **por cima**, e
 * P4 exige que o plano exista inteiro sem ele.
 *
 * Duas regras atravessam todos os kinds:
 *
 * 1. **Nenhum tipo fica órfão.** Quando a ação não é aplicável — sem substituto
 *    criativo, sem nível de orçamento, texto autoral indisponível — a
 *    recomendação vira **consultiva** com `outOfScopeReason`. Silêncio nunca é
 *    resposta: o diagnóstico continua sendo verdadeiro.
 * 2. **Bloqueio é visível.** As guardas não descartam o plano; elas o marcam com
 *    `blockedReason`. É informação para o usuário e sinal de calibração para P8 —
 *    e a taxa de bloqueio por guarda é o que diz se um limiar está errado.
 */

const PRIORITY_BY_WASTE: Readonly<
  Record<WastePriority, RecommendationPriority>
> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

/** Confiança da projeção, por tipo de impacto (§9.7). */
const IMPACT_CONFIDENCE: Readonly<Record<string, number>> = {
  // Gasto interrompido é verificável diretamente.
  SAVINGS: 0.8,
  // CPA/ROAS melhorado com gasto comparável.
  EFFICIENCY_GAIN: 0.5,
  // Sazonalidade, leilão, saturação: a menos confiável das três.
  REVENUE_UPLIFT: 0.3,
};

export function plan(signals: RecommendationSignals): RecommendationPlan[] {
  const byKind = groupFindingsByKind(signals.findings);
  const plans: RecommendationPlan[] = [];

  for (const [kind, findings] of byKind) {
    const built = planForKind(kind, findings, signals);
    if (built) plans.push(built);
  }

  // `REPLACE_CTA` é o único kind sem achado de origem (§9.3): ele nasce do
  // score. O público certo está chegando — `audienceFit` alto — e não converte
  // como os pares, o que aponta para a chamada e o destino, não para a
  // segmentação. Sem esta derivação o kind ficaria órfão no catálogo.
  const cta = planReplaceCta(signals);
  if (cta) plans.push(cta);

  return plans;
}

function groupFindingsByKind(
  findings: FindingSignal[],
): Map<RecommendationKind, FindingSignal[]> {
  const grouped = new Map<RecommendationKind, FindingSignal[]>();

  for (const finding of findings) {
    const kind = kindForFinding(finding.type);
    const bucket = grouped.get(kind) ?? [];
    bucket.push(finding);
    grouped.set(kind, bucket);
  }

  return grouped;
}

function planForKind(
  kind: RecommendationKind,
  findings: FindingSignal[],
  signals: RecommendationSignals,
): RecommendationPlan | null {
  const { ad, thresholds } = signals;

  // §9.4 passo 4 usa o evitável para desempatar conflito, e §9.7 o usa como base
  // da projeção. É o `max` de §10.6 entre os achados que originam este kind —
  // nunca a soma, que contaria o mesmo gasto duas vezes.
  const avoidableDailyBase = Math.max(
    ...findings.map((finding) => finding.avoidableDailyBase),
    0,
  );
  const worstPriority = findings.reduce<WastePriority>(
    (worst, finding) =>
      rankOf(finding.priority) > rankOf(worst) ? finding.priority : worst,
    'LOW',
  );

  const guard =
    kind === 'SCALE_WINNING_AD'
      ? evaluateScaleGuards(signals)
      : { allowed: true as const, blockedReason: null };

  // A entrada de `SCALE_WINNING_AD` é dupla (§9.3): score alto **e** ROAS acima
  // do dobro da mediana dos pares. Sem o segundo, "campeão" seria só um número
  // do nosso próprio modelo concordando consigo mesmo.
  if (kind === 'SCALE_WINNING_AD' && !qualifiesForScale(signals)) return null;

  // §11.4 — **sem candidato, o kind inteiro vira consultivo**, e não cai para
  // `PAUSE_AD`. A guarda de §9.3 é "criativo substituto disponível": pausar um
  // anúncio cujo criativo cansou é jogar fora o desempenho que ele ainda tem,
  // quando o remédio era trocar a peça. "Suba um criativo novo" é a resposta
  // honesta; pausar seria resolver o registro, não o problema.
  const missingReplacement =
    kind === 'REFRESH_FATIGUED_CREATIVE' && !signals.replacementCreativeId;

  const budget: BudgetIntent | undefined = isBudgetKind(kind)
    ? {
        delta:
          kind === 'SCALE_WINNING_AD'
            ? thresholds.scaleIncreaseFactor
            : -thresholds.budgetReductionFactor,
        adsInAdSet: 1,
        adsInCampaign: 1,
      }
    : undefined;

  const resolution = missingReplacement
    ? {
        resolved: false as const,
        outOfScopeReason:
          'Este criativo se esgotou e não há substituto já veiculado nesta conta. ' +
          'A Allva não origina mídia (P1).',
      }
    : resolveAction({
        alternatives: ACTION_PLAN_BY_KIND[kind],
        ad,
        budget,
        replacementCreativeId: signals.replacementCreativeId,
        selectedCopy: signals.selectedCopy,
      });

  const advisory = isAdvisoryKind(kind) || !resolution.resolved;
  const impactType = IMPACT_TYPE_BY_KIND[kind];

  return {
    adId: ad.adId,
    kind,
    advisory,
    priority: PRIORITY_BY_WASTE[worstPriority],
    title: titleFor(kind, avoidableDailyBase, ad.baseCurrency),
    rationale: rationaleFor(kind, findings),
    guidance: advisory ? guidanceFor(kind) : null,
    // Consultiva **por escopo** declara a razão de escopo, não a de "nenhuma
    // ação aplicável": `EXPAND_AUDIENCE` não tem ação porque a Allva decidiu não
    // gerir audiências, e não porque a plataforma não suporta.
    outOfScopeReason: isAdvisoryKind(kind)
      ? 'Expandir público é feito no gerenciador da plataforma. A Allva não gere audiências.'
      : resolution.resolved
        ? null
        : resolution.outOfScopeReason,
    blockedReason: guard.blockedReason,
    wasteItemIds: findings.map((finding) => finding.id),
    impacts: [
      {
        type: impactType,
        // §9.7: o estimado é **sempre** projeção do evitável diário sobre o
        // horizonte declarado. É isso que o torna comparável com o
        // `observedDelta` medido depois — duas fórmulas diferentes fariam a
        // comparação de P8 medir a diferença entre elas.
        estimatedBase: round2(
          avoidableDailyBase * thresholds.impactHorizonDays,
        ),
        horizonDays: thresholds.impactHorizonDays,
        confidence: IMPACT_CONFIDENCE[impactType] ?? 0.5,
      },
    ],
    primaryImpactType: PRIMARY_IMPACT_BY_KIND[kind],
    // Consultiva e bloqueada não carregam ação: a primeira por escopo, a segunda
    // porque a guarda disse que não é hora. As duas continuam na tela.
    actions:
      resolution.resolved && !advisory && guard.allowed
        ? [resolution.action]
        : [],
    evidence: {
      findingTypes: findings.map((finding) => finding.type),
      avoidableDailyBase,
      aiScore: signals.score?.aiScore ?? null,
      aiConfidence: signals.score?.aiConfidence ?? null,
      dataMaturity: ad.dataMaturity,
      /**
       * A maturidade **desta** evidência, gravada junto dela.
       *
       * `dataMaturity` acima descreve a série corrente do anúncio e continua
       * ali como leitura. O que a revalidação da premissa precisa é o estado da
       * janela que sustentou o veredito — e num anúncio que entrega todo dia os
       * dois divergem para sempre, porque o primeiro nunca sai de `IMMATURE`.
       *
       * Achado de desperdício já nasce de janela assentada desde a correção de
       * §8.9; sem achado, o que sustenta é o score, que olha até hoje.
       */
      windowMaturity: findings.length > 0 ? 'MATURE' : ad.dataMaturity,
    },
    evidenceAsOf: signals.score?.scoredAt ?? signals.now,
    expiresAt: addDays(signals.now, thresholds.expiryDays),
  };
}

/**
 * `REPLACE_CTA` — público certo chegando, conversão abaixo dos pares.
 *
 * Não vem de achado nenhum: `audienceFit` alto diz que a segmentação está
 * correta, e ROAS abaixo da mediana do conjunto com o mesmo público aponta para
 * o que acontece **depois do clique**. Trocar a segmentação aqui seria consertar
 * o que não está quebrado.
 */
function planReplaceCta(
  signals: RecommendationSignals,
): RecommendationPlan | null {
  const { ad, score, thresholds } = signals;
  if (!score || score.audienceFit === null) return null;
  // Aderência de conversão só existe em quem busca conversão.
  if (!judgesConversion(ad.optimization)) return null;

  const efficiency = efficiencyVsPeers(ad);
  if (!efficiency) return null;

  const fitIsGood = score.audienceFit >= 60;
  const conversionLags = efficiency.ratio < 0.7;
  if (!fitIsGood || !conversionLags) return null;

  const resolution = resolveAction({
    alternatives: ACTION_PLAN_BY_KIND.REPLACE_CTA,
    ad,
    selectedCopy: signals.selectedCopy,
  });

  return {
    adId: ad.adId,
    kind: 'REPLACE_CTA',
    /**
     * **Consultiva só enquanto não há chamada escolhida.**
     *
     * Era `advisory: true` fixo, com a nota de que o parâmetro é texto autoral e
     * não tinha de onde vir. Agora tem: a variação escolhida no Copy Studio. A
     * exigência de R14 não mudou nem foi afrouxada — a confirmação explícita do
     * texto final continua acontecendo na execução, e o lote continua recusado.
     * O que mudou é que a recomendação deixa de ser um conselho quando existe
     * um texto que a pessoa já escolheu.
     */
    advisory: !resolution.resolved,
    priority: 'MEDIUM',
    title: 'Revisar a chamada para ação deste anúncio',
    rationale:
      `O público certo está chegando (audience fit ${score.audienceFit.toFixed(0)}/100), ` +
      `mas ${efficiency.describe} ` +
      'dos pares do mesmo conjunto — o que acontece depois do clique é o que difere.',
    guidance:
      'Revise a chamada para ação e a página de destino. Trocar a segmentação ' +
      'consertaria o que não está quebrado.',
    outOfScopeReason: resolution.resolved ? null : resolution.outOfScopeReason,
    blockedReason: null,
    wasteItemIds: [],
    impacts: [
      {
        type: IMPACT_TYPE_BY_KIND.REPLACE_CTA,
        estimatedBase: 0,
        horizonDays: thresholds.impactHorizonDays,
        confidence: IMPACT_CONFIDENCE.EFFICIENCY_GAIN,
      },
    ],
    primaryImpactType: PRIMARY_IMPACT_BY_KIND.REPLACE_CTA,
    actions: resolution.resolved ? [resolution.action] : [],
    evidence: {
      audienceFit: score.audienceFit,
      efficiencyMetric: efficiency.metric,
      roas: ad.roas,
      peerMedianRoas: ad.peerMedianRoas,
      cpa: ad.cpa,
      peerMedianCpa: ad.peerMedianCpa,
      // Sem achado por trás, quem sustenta é o score — e ele olha até hoje.
      windowMaturity: ad.dataMaturity,
    },
    evidenceAsOf: score.scoredAt,
    expiresAt: addDays(signals.now, thresholds.expiryDays),
  };
}

function qualifiesForScale(signals: RecommendationSignals): boolean {
  const { ad, score, thresholds } = signals;
  if (!score) return false;
  if (score.aiScore < thresholds.scaleMinScore) return false;
  // Escalar é a única ação que aumenta gasto: exige saber o que o anúncio
  // converte. Alcance e tráfego não entram, e evento não contável também não.
  if (!judgesConversion(ad.optimization)) return false;

  const efficiency = efficiencyVsPeers(ad);
  if (!efficiency) return false;

  return efficiency.ratio >= thresholds.scaleRoasMultiple;
}

/**
 * Quanto o anúncio rende **em relação aos pares do mesmo conjunto**, na régua
 * que o evento dele permite. Maior é melhor nas duas.
 *
 * - Evento com valor (compra): `ROAS / mediana de ROAS`.
 * - Evento sem valor (lead, cadastro, instalação...): `mediana de CPA / CPA` —
 *   ROAS não existe onde não há receita, e sem esta régua um anúncio de lead
 *   nunca seria candidato a escala, por melhor que fosse.
 *
 * A escolha é pela mediana dos pares, não pelo anúncio: se o conjunto registra
 * receita, a comparação é por receita para todos eles.
 */
function efficiencyVsPeers(ad: AdSignal): {
  metric: 'ROAS' | 'CPA';
  ratio: number;
  describe: string;
} | null {
  if (ad.peerMedianRoas !== null && ad.peerMedianRoas > 0) {
    if (ad.roas === null) return null;
    return {
      metric: 'ROAS',
      ratio: ad.roas / ad.peerMedianRoas,
      describe:
        `o ROAS ${ad.roas.toFixed(2)} está abaixo da mediana ` +
        `${ad.peerMedianRoas.toFixed(2)}`,
    };
  }

  if (
    ad.cpa !== null &&
    ad.cpa > 0 &&
    ad.peerMedianCpa !== null &&
    ad.peerMedianCpa > 0
  ) {
    return {
      metric: 'CPA',
      ratio: ad.peerMedianCpa / ad.cpa,
      describe:
        `o custo por conversão ${ad.cpa.toFixed(2)} ${ad.baseCurrency} está acima ` +
        `da mediana ${ad.peerMedianCpa.toFixed(2)} ${ad.baseCurrency}`,
    };
  }

  return null;
}

function isBudgetKind(kind: RecommendationKind): boolean {
  return (
    kind === 'REDUCE_BUDGET_HIGH_CPA' ||
    kind === 'STABILIZE_LEARNING' ||
    kind === 'SCALE_WINNING_AD'
  );
}

const TITLES: Readonly<Record<RecommendationKind, string>> = {
  PAUSE_UNDERPERFORMING_AD: 'Pausar anúncio sem retorno',
  REFRESH_FATIGUED_CREATIVE: 'Trocar o criativo cansado',
  IMPROVE_WEAK_HOOK: 'Melhorar o gancho do anúncio',
  REPLACE_CTA: 'Revisar a chamada para ação',
  MITIGATE_NEGATIVE_FEEDBACK: 'Conter o feedback negativo',
  REDUCE_BUDGET_HIGH_CPA: 'Reduzir orçamento com CPA alto',
  STABILIZE_LEARNING: 'Estabilizar o aprendizado',
  CONSOLIDATE_OVERLAP: 'Consolidar anúncios idênticos',
  EXPAND_AUDIENCE: 'Expandir o público do conjunto',
  SCALE_WINNING_AD: 'Escalar anúncio campeão',
};

function titleFor(
  kind: RecommendationKind,
  avoidableDailyBase: number,
  baseCurrency: string,
): string {
  if (avoidableDailyBase <= 0) return TITLES[kind];

  // `toFixed(2)` mais o código ISO imprimia `532.44 BRL/dia` no título de capa
  // da recomendação — ponto decimal de outra localidade e a moeda como sigla,
  // no mesmo card em que a economia estimada aparece como `R$ 7.454,16`.
  const amount = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: baseCurrency,
  }).format(avoidableDailyBase);

  return `${TITLES[kind]} — ${amount}/dia`;
}

/**
 * De onde a recomendação veio, **pelo nome do achado**.
 *
 * `ZERO_CONVERSIONS` é chave de catálogo e de fingerprint; na justificativa ela
 * pedia ao usuário que traduzisse uma constante de código para entender por que
 * a Allva está sugerindo pausar o anúncio dele. O `kind` do caso sem achado
 * saía cru pela mesma razão — e ali o título já diz o que é, então repeti-lo
 * como enum não acrescentava nada.
 */
function rationaleFor(
  kind: RecommendationKind,
  findings: FindingSignal[],
): string {
  const types = findings
    .map((finding) => findingLabel(finding.type))
    .join(', ');

  return types
    ? `Originada por ${types.toLowerCase()}, com evidência declarada no achado.`
    : 'Originada pelo AI Score corrente, sem achado aberto que a sustente.';
}

const GUIDANCE: Readonly<Partial<Record<RecommendationKind, string>>> = {
  EXPAND_AUDIENCE:
    'O público deste conjunto está saturado: amplie a segmentação ou crie um ' +
    'público semelhante no gerenciador da plataforma.',
  REFRESH_FATIGUED_CREATIVE:
    'Este criativo se esgotou e não há substituto na conta. Suba um criativo ' +
    'novo na plataforma — a Allva não origina mídia.',
};

function guidanceFor(kind: RecommendationKind): string {
  return (
    GUIDANCE[kind] ??
    'A ação prevista não é aplicável a este anúncio; o diagnóstico continua válido.'
  );
}

function rankOf(priority: WastePriority): number {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(priority);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
