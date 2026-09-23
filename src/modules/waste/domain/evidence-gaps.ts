import {
  conversionEventLabel,
  describeOptimization,
} from 'src/modules/integrations/domain/entities/optimization-target';
import type { FindingType } from './contracts/finding-catalog';
import type {
  AdWindowAggregate,
  EvidenceGapCode,
  Insufficiency,
} from './detection-context';

/**
 * O **silêncio explicado** — função pura.
 *
 * ## O problema
 *
 * A evidência mínima (P7) faz a Allva ficar calada sobre o anúncio que ainda
 * não tem dado suficiente, e isso é o comportamento certo: mandar pausar um
 * anúncio em aprendizado destrói tanto valor quanto o desperdício. Mas o
 * silêncio chegava à tela como lista vazia — a mesma de "olhamos e está tudo
 * bem". Numa conta nova ou pequena, o produto parecia vazio exatamente quando
 * estava sendo mais cuidadoso.
 *
 * O portão já sabia o motivo de cada recusa; o ciclo só o contava
 * (`outcome.insufficient += 1`) e jogava fora. Aqui ele vira dado de tela: por
 * anúncio, **o que falta, para quais detectores, e quando deve chegar**.
 *
 * ## A estimativa
 *
 * "Quando" é uma projeção pelo ritmo recente do próprio anúncio, e diz isso.
 * Duas coisas a tornam honesta:
 *
 * 1. **A janela julgada pode estar defasada.** Os detectores de conversão
 *    julgam uma janela que termina antes dos dias ainda em re-declaração
 *    (§8.9). Um anúncio que começou ontem só entra nela depois da defasagem —
 *    a estimativa conta a partir daí, não de hoje.
 * 2. **A janela desliza.** Com 14 dias de janela, um anúncio que gasta R$ 2
 *    por dia nunca junta os R$ 50 do piso: dia novo entra, dia velho sai. Aí a
 *    resposta não é uma data — é "no ritmo atual, não chega", que é a
 *    informação que a pessoa precisa para decidir.
 */

export type EvidenceGapNature = 'AWAITING' | 'STRUCTURAL' | 'NOT_APPLICABLE';

export type EvidenceGap = {
  code: EvidenceGapCode;
  nature: EvidenceGapNature;
  /** Os detectores que esperam por este motivo. */
  detectorTypes: FindingType[];
  /** Uma frase, em português, com o número quando há número. */
  reason: string;
  current: number | null;
  required: number | null;
  /** Dia (UTC, `YYYY-MM-DD`) em que a evidência deve chegar; `null` quando não há como prever. */
  estimatedReadyOn: string | null;
  /**
   * `true` quando, no ritmo atual, a janela nunca junta o mínimo — o dia novo
   * que entra repõe só o dia velho que sai.
   */
  unreachableAtCurrentPace: boolean;
};

const NATURE: Readonly<Record<EvidenceGapCode, EvidenceGapNature>> = {
  AWAITING_DAYS: 'AWAITING',
  AWAITING_IMPRESSIONS: 'AWAITING',
  AWAITING_SPEND: 'AWAITING',
  AWAITING_CONVERSIONS: 'AWAITING',
  AWAITING_MATURITY: 'AWAITING',
  AWAITING_SCORE: 'AWAITING',
  OBJECTIVE_UNKNOWN: 'AWAITING',
  AD_LEFT_AD_SET: 'AWAITING',
  NO_BENCHMARK: 'STRUCTURAL',
  OBJECTIVE_NOT_CONVERSION: 'NOT_APPLICABLE',
  CONVERSION_NOT_MEASURABLE: 'NOT_APPLICABLE',
  COMPONENT_UNAVAILABLE: 'NOT_APPLICABLE',
};

export function natureOf(code: EvidenceGapCode): EvidenceGapNature {
  return NATURE[code];
}

/** O motivo de uma recusa, com a defasagem da janela que o detector julgou. */
export type SlicedInsufficiency = Insufficiency & {
  /** Dias entre hoje e o fim da janela julgada (§8.9). 0 no recorte corrente. */
  lagDays: number;
};

type MetricOfCode = 'spendBase' | 'impressions' | 'conversions';

const METRIC_OF: Partial<Record<EvidenceGapCode, MetricOfCode>> = {
  AWAITING_SPEND: 'spendBase',
  AWAITING_IMPRESSIONS: 'impressions',
  AWAITING_CONVERSIONS: 'conversions',
};

/** Quantos dias recentes medem o ritmo: uma semana cobre o ciclo semanal do leilão. */
const PACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeEvidenceGaps(input: {
  insufficiencies: SlicedInsufficiency[];
  /** O retrato corrente do anúncio (recorte sem defasagem): a fonte do ritmo. */
  recent: AdWindowAggregate;
  /** O primeiro dia com observação em toda a leitura — define quando a janela defasada começa a encher. */
  firstObservedOn: Date | null;
  windowDays: number;
  now: Date;
}): EvidenceGap[] {
  const groups = new Map<string, SlicedInsufficiency[]>();

  for (const insufficiency of input.insufficiencies) {
    // Agrupa por motivo **e** mínimo: "3 de 7 dias" e "3 de 5 dias" chegam em
    // datas diferentes e liberam detectores diferentes.
    const key = `${insufficiency.code}:${insufficiency.required ?? ''}:${insufficiency.lagDays}`;
    const list = groups.get(key) ?? [];
    list.push(insufficiency);
    groups.set(key, list);
  }

  const gaps = [...groups.values()].map((list) => toGap(list, input));

  return mergeSameCode(gaps).sort(compareGaps);
}

function toGap(
  list: SlicedInsufficiency[],
  input: {
    recent: AdWindowAggregate;
    firstObservedOn: Date | null;
    windowDays: number;
    now: Date;
  },
): EvidenceGap {
  const first = list[0];
  const detectorTypes = [...new Set(list.map((item) => item.type))].sort();
  const estimate = estimateReadiness({
    code: first.code,
    current: first.current ?? null,
    required: first.required ?? null,
    lagDays: first.lagDays,
    ...input,
  });

  return {
    code: first.code,
    nature: natureOf(first.code),
    detectorTypes,
    reason: reasonFor(first, input.recent),
    current: first.current ?? null,
    required: first.required ?? null,
    estimatedReadyOn: estimate.readyOn,
    unreachableAtCurrentPace: estimate.unreachable,
  };
}

/**
 * Motivos iguais vindos de recortes diferentes viram uma linha: a mesma frase
 * duas vezes, com datas diferentes, confundiria mais do que informa. Fica a
 * data mais distante — é quando **todos** os detectores daquele motivo julgam.
 */
function mergeSameCode(gaps: EvidenceGap[]): EvidenceGap[] {
  const merged = new Map<string, EvidenceGap>();

  for (const gap of gaps) {
    const key = `${gap.code}:${gap.required ?? ''}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, gap);
      continue;
    }

    merged.set(key, {
      ...existing,
      detectorTypes: [
        ...new Set([...existing.detectorTypes, ...gap.detectorTypes]),
      ].sort(),
      current:
        existing.current === null || gap.current === null
          ? (existing.current ?? gap.current)
          : Math.min(existing.current, gap.current),
      estimatedReadyOn: laterOf(
        existing.estimatedReadyOn,
        gap.estimatedReadyOn,
      ),
      unreachableAtCurrentPace:
        existing.unreachableAtCurrentPace || gap.unreachableAtCurrentPace,
    });
  }

  return [...merged.values()];
}

function laterOf(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return a > b ? a : b;
}

const NATURE_ORDER: Record<EvidenceGapNature, number> = {
  AWAITING: 0,
  STRUCTURAL: 1,
  NOT_APPLICABLE: 2,
};

function compareGaps(a: EvidenceGap, b: EvidenceGap): number {
  const byNature = NATURE_ORDER[a.nature] - NATURE_ORDER[b.nature];
  if (byNature !== 0) return byNature;
  // Com data antes de sem data; entre datas, a mais próxima primeiro.
  if (a.estimatedReadyOn && b.estimatedReadyOn) {
    return a.estimatedReadyOn.localeCompare(b.estimatedReadyOn);
  }
  if (a.estimatedReadyOn) return -1;
  if (b.estimatedReadyOn) return 1;
  return a.code.localeCompare(b.code);
}

/**
 * Quando a evidência deve chegar.
 *
 * Só motivos que o tempo resolve têm data. Anúncio pausado não acumula nada —
 * sem data, e a tela não finge que ele vai "amadurecer".
 */
export function estimateReadiness(input: {
  code: EvidenceGapCode;
  current: number | null;
  required: number | null;
  lagDays: number;
  recent: AdWindowAggregate;
  firstObservedOn: Date | null;
  windowDays: number;
  now: Date;
}): { readyOn: string | null; unreachable: boolean } {
  const none = { readyOn: null, unreachable: false };
  if (natureOf(input.code) !== 'AWAITING') return none;

  const today = utcDay(input.now);

  // O score sai no ciclo da madrugada seguinte; o objetivo, no próximo sync.
  if (input.code === 'AWAITING_SCORE' || input.code === 'OBJECTIVE_UNKNOWN') {
    return { readyOn: isoDay(addDays(today, 1)), unreachable: false };
  }

  if (!input.recent.isDelivering) return none;
  if (input.current === null || input.required === null) return none;

  // A janela defasada só começa a receber dias quando o primeiro dia do anúncio
  // sai da faixa de re-declaração.
  const fillsFrom = input.firstObservedOn
    ? maxDay(today, addDays(utcDay(input.firstObservedOn), input.lagDays))
    : today;

  const missing = input.required - input.current;
  if (missing <= 0) return { readyOn: isoDay(fillsFrom), unreachable: false };

  if (input.code === 'AWAITING_DAYS') {
    return { readyOn: isoDay(addDays(fillsFrom, missing)), unreachable: false };
  }

  const metric = METRIC_OF[input.code];
  if (!metric) return none;

  const pace = dailyPace(input.recent, metric);
  if (pace <= 0) return none;

  // A janela desliza: no ritmo atual ela comporta, no máximo, `pace × janela`.
  if (pace * input.windowDays < input.required) {
    return { readyOn: null, unreachable: true };
  }

  return {
    readyOn: isoDay(addDays(fillsFrom, Math.ceil(missing / pace))),
    unreachable: false,
  };
}

/** Média por dia dos últimos dias observados — nunca do período inteiro, que diluiria uma aceleração recente. */
function dailyPace(ad: AdWindowAggregate, metric: MetricOfCode): number {
  const recent = [...ad.daily]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(-PACE_DAYS);
  if (recent.length === 0) return 0;

  const total = recent.reduce((sum, point) => sum + point[metric], 0);
  return total / recent.length;
}

function reasonFor(
  insufficiency: SlicedInsufficiency,
  ad: AdWindowAggregate,
): string {
  const { code, current, required } = insufficiency;
  const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

  switch (code) {
    case 'AWAITING_DAYS':
      return `${current ?? 0} de ${required ?? 0} dias de série na janela analisada.`;
    case 'AWAITING_IMPRESSIONS':
      return `${number.format(current ?? 0)} de ${number.format(required ?? 0)} impressões na janela.`;
    case 'AWAITING_SPEND': {
      const money = new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: ad.baseCurrency,
      });
      return `Gasto de ${money.format(current ?? 0)} de ${money.format(required ?? 0)} na janela.`;
    }
    case 'AWAITING_CONVERSIONS': {
      const event = ad.optimization.conversionEvent;
      const what = event ? ` (${conversionEventLabel(event)})` : '';
      return `${number.format(current ?? 0)} de ${number.format(required ?? 0)} conversões${what} na janela.`;
    }
    case 'NO_BENCHMARK':
      return (
        `${current ?? 0} anúncio(s) comparável(is), otimizados para ` +
        `${describeOptimization(ad.optimization)}; a comparação exige ${required ?? 3}.`
      );
    default:
      return insufficiency.reason;
  }
}

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function maxDay(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
