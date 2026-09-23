import {
  clamp,
  computeConfidence,
  isPresent,
  normalize,
  weightedAverage,
} from './score-math';
import { CreativeAggregate, ScoreResult } from './score-types';

/**
 * Negative Feedback Risk (0-100). HIGHER means MORE risk.
 *
 * ## Dívida paga (deterministic-v2.1)
 *
 * Até aqui o sinal era 100% heurístico: `available`/`proxyBased` já liam
 * `hides`/`hideAllFor`/`reports`/`unlikes` da linha para decidir se "o sinal
 * real chegou" (§12.2), mas o composto **nunca olhava esses campos** — media
 * proxy sempre, e `proxyBased: false` virava uma afirmação falsa assim que a
 * Meta mandava dado de verdade. `scoring-calculators.spec.ts` fixava isso a
 * propósito, com o comentário "quando passar a ler, ele quebra" — esta versão
 * é essa quebra.
 *
 * O sinal explícito (`explicit`) entra como um quinto componente, pesado a
 * 50%: mais confiável que qualquer proxy porque é o que ele promete medir, não
 * uma inferência sobre outra coisa. Quando ausente (Google, TikTok, ou Meta
 * sem volume suficiente para o Graph reportar a ação), `weightedAverage`
 * ignora o componente e redistribui o peso pelos quatro proxies nas MESMAS
 * proporções de antes — o resultado é numericamente idêntico ao de hoje para
 * quem não tem o sinal. Ver `scoring-calculators.spec.ts` para a prova.
 *
 * A mistura de proxies continua — inclusive na Meta: nenhuma plataforma
 * declara ação negativa por criativo com granularidade fina o bastante para
 * dispensar o proxy, e um dia isolado de `hides` alto pode ser ruído.
 *
 * - Frequency ramp: high frequency strongly correlates with hide/report rate.
 * - CTR decline (recent half vs older half): a falling CTR at flat spend is
 *   the classic ad-fatigue fingerprint.
 * - CPM spike (recent half vs older half): rising CPM signals auction-side
 *   penalty (low quality ranking).
 * - Saturation proxy: clicks growth slowing while impressions keep rising.
 * - Explicit: weighted rate of hide/hide-all/report/unlike per 1,000
 *   impressions — real platform signal, today only from the Meta Graph API.
 */

const ANCHORS = {
  frequencyRisk: { low: 2.0, high: 6.0 },
  ctrDeclinePct: { low: 0, high: 0.5 }, // 0-50% drop
  cpmSpikePct: { low: 0, high: 0.5 }, // 0-50% spike
  saturationRatio: { low: 0.4, high: 1.0 }, // newer/older clicks-per-impression ratio
  /**
   * Eventos ponderados por 1.000 impressões. Banda inicial, não calibrada
   * contra distribuição real — declarado, não escondido atrás de um número
   * que parece preciso (P7): falta um histórico de contas Meta grande o
   * bastante para ancorar isto em percentil observado, e é a próxima revisão
   * óbvia assim que houver.
   */
  explicitRate: { low: 0.1, high: 3.0 },
};

/**
 * `hideAllFor` e `reports` pesam mais que `hides`: bloquear TODO post futuro
 * da conta e denunciar como spam são ações mais raras e mais graves que
 * ocultar um post isolado. `unlikes` pesa menos porque é ação de **página**,
 * não deste anúncio especificamente — pode ter sido disparada por outro
 * criativo da mesma conta.
 */
const EXPLICIT_EVENT_WEIGHTS = {
  hides: 1,
  hideAllFor: 2,
  reports: 2.5,
  unlikes: 0.5,
};

/** Piso de confiança quando o sinal é real, não proxy — não depende do volume
 * de impressões da forma que a heurística depende. */
const EXPLICIT_CONFIDENCE_FLOOR = 0.7;

const WEIGHTS = {
  frequency: 0.16,
  ctrDecline: 0.14,
  cpmSpike: 0.1,
  saturation: 0.1,
  explicit: 0.5,
};

function splitDaily(aggregate: CreativeAggregate) {
  const sorted = [...aggregate.daily].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const mid = Math.floor(sorted.length / 2);
  return { older: sorted.slice(0, mid), newer: sorted.slice(mid) };
}

function avg(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter(isPresent);
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

function totalsCpm(days: CreativeAggregate['daily']): number | null {
  const spend = days.reduce((a, b) => a + b.spend, 0);
  const impressions = days.reduce((a, b) => a + b.impressions, 0);
  if (impressions <= 0) return null;
  return (spend / impressions) * 1000;
}

function clicksPerImpression(days: CreativeAggregate['daily']): number | null {
  const clicks = days.reduce((a, b) => a + b.clicks, 0);
  const impressions = days.reduce((a, b) => a + b.impressions, 0);
  if (impressions <= 0) return null;
  return clicks / impressions;
}

export class NegativeFeedbackRiskCalculator {
  static calculate(aggregate: CreativeAggregate): ScoreResult {
    const { averages, totals, daily, negativeFeedback } = aggregate;

    const frequencyRisk = normalize(
      averages.frequency,
      ANCHORS.frequencyRisk.low,
      ANCHORS.frequencyRisk.high,
    );

    let ctrDeclineRisk: number | null = null;
    let cpmSpikeRisk: number | null = null;
    let saturationRisk: number | null = null;

    if (daily.length >= 4) {
      const { older, newer } = splitDaily(aggregate);

      const olderCtr = avg(older.map((d) => d.ctr));
      const newerCtr = avg(newer.map((d) => d.ctr));
      if (isPresent(olderCtr) && isPresent(newerCtr) && olderCtr > 0) {
        const dropPct = (olderCtr - newerCtr) / olderCtr;
        ctrDeclineRisk = normalize(
          dropPct,
          ANCHORS.ctrDeclinePct.low,
          ANCHORS.ctrDeclinePct.high,
        );
      }

      const olderCpm = totalsCpm(older);
      const newerCpm = totalsCpm(newer);
      if (isPresent(olderCpm) && isPresent(newerCpm) && olderCpm > 0) {
        const spikePct = (newerCpm - olderCpm) / olderCpm;
        cpmSpikeRisk = normalize(
          spikePct,
          ANCHORS.cpmSpikePct.low,
          ANCHORS.cpmSpikePct.high,
        );
      }

      const olderCli = clicksPerImpression(older);
      const newerCli = clicksPerImpression(newer);
      if (isPresent(olderCli) && isPresent(newerCli) && olderCli > 0) {
        const ratio = newerCli / olderCli;
        // ratio < 1 means newer engagement is lower → saturating.
        // Invert: lower ratio → higher risk.
        const inverted = 1 - clamp(ratio, 0, 1);
        saturationRisk = normalize(
          inverted,
          ANCHORS.saturationRatio.low - 0.4,
          ANCHORS.saturationRatio.high,
        );
      }
    }

    // `present` distingue "a plataforma nunca disse" de "disse zero" (P7) —
    // sem ele, Google e TikTok teriam um sinal explícito de risco zero
    // ENTRANDO no composto a 50% de peso, o que os deixaria artificialmente
    // mais seguros que hoje em vez de simplesmente sem o sinal.
    const explicitRisk =
      negativeFeedback.present && totals.impressions > 0
        ? normalize(
            ((negativeFeedback.hides * EXPLICIT_EVENT_WEIGHTS.hides +
              negativeFeedback.hideAllFor * EXPLICIT_EVENT_WEIGHTS.hideAllFor +
              negativeFeedback.reports * EXPLICIT_EVENT_WEIGHTS.reports +
              negativeFeedback.unlikes * EXPLICIT_EVENT_WEIGHTS.unlikes) /
              totals.impressions) *
              1000,
            ANCHORS.explicitRate.low,
            ANCHORS.explicitRate.high,
          )
        : null;

    const composite = weightedAverage([
      { value: frequencyRisk, weight: WEIGHTS.frequency },
      { value: ctrDeclineRisk, weight: WEIGHTS.ctrDecline },
      { value: cpmSpikeRisk, weight: WEIGHTS.cpmSpike },
      { value: saturationRisk, weight: WEIGHTS.saturation },
      { value: explicitRisk, weight: WEIGHTS.explicit },
    ]);

    // Fallback: no signals → low risk by default (we don't punish what we
    // cannot see). With high spend and no quality data, nudge slightly up.
    let value: number;
    if (composite === null) {
      value = totals.spend > 500 ? 30 : 15;
    } else {
      value = composite * 100;
    }

    // O sinal explícito não entra nesta contagem de propósito: `expectedSignals`
    // continua 4, os quatro proxies universais. Contar 5 puniria Google e
    // TikTok com um teto de confiança que nenhum dado seu algum dia alcança —
    // o mesmo erro de `platformCoverageMax` antes de `nonVideoCoverageMaxFor`,
    // aqui evitado desde o início em vez de corrigido depois.
    const present = [
      frequencyRisk,
      ctrDeclineRisk,
      cpmSpikeRisk,
      saturationRisk,
    ].filter((s) => s !== null).length;

    let confidence = computeConfidence({
      presentSignals: present,
      expectedSignals: 4,
      impressions: totals.impressions,
      volumeAt: 5000,
    });

    // Piso, não teto: o sinal real não some se a heurística ao lado dele for
    // fraca — ele é o que a heurística inteira existe para aproximar.
    if (explicitRisk !== null) {
      confidence = Math.max(confidence, EXPLICIT_CONFIDENCE_FLOOR);
    }

    const reasons: string[] = [];
    if (frequencyRisk !== null && frequencyRisk > 0.6)
      reasons.push('Frequência alta — risco de fadiga/rejeição');
    if (ctrDeclineRisk !== null && ctrDeclineRisk > 0.5)
      reasons.push('CTR caindo nos últimos dias');
    if (cpmSpikeRisk !== null && cpmSpikeRisk > 0.5)
      reasons.push('CPM subindo — possível queda de quality ranking');
    if (saturationRisk !== null && saturationRisk > 0.5)
      reasons.push('Saturação detectada (impressões crescendo, cliques não)');
    if (explicitRisk !== null && explicitRisk > 0.5)
      reasons.push(
        'Sinal direto da plataforma: taxa de ocultar/denunciar acima do esperado',
      );

    return {
      value: Math.round(clamp(value, 0, 100)),
      confidence,
      signals: {
        frequency: frequencyRisk,
        ctrDecline: ctrDeclineRisk,
        cpmSpike: cpmSpikeRisk,
        saturation: saturationRisk,
        explicit: explicitRisk,
      },
      reasons,
    };
  }
}
