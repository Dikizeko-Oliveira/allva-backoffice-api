import type { OutcomeDeltaKind } from './contracts/recommendation-catalog';

/**
 * A medição pré/pós de C4 — **função pura**, como toda decisão que o produto
 * afirma sobre a mídia de alguém.
 *
 * > Isto é medição pré/pós, **não atribuição causal** (§9.7, D6). O contrato
 * > rotula `observedDelta`, jamais `causedSavings`, e expõe `confounders`
 * > quando são detectáveis.
 *
 * A distinção não é retórica. Um anúncio pausado gasta zero na janela pós, e a
 * diferença é real; o que ninguém pode afirmar é que a economia inteira se deve
 * à recomendação — o orçamento pode ter migrado para outro anúncio da mesma
 * conta, a sazonalidade pode ter mudado o leilão, o cliente pode ter mexido em
 * três coisas no mesmo dia. Os confounders existem para que o número venha
 * acompanhado do que se sabe contra ele.
 */

/**
 * A **terceira** coisa versionada do sistema, ao lado de `algoVersion` e
 * `detectorVersion` (§4.5).
 *
 * §20-H3 condiciona a automação supervisionada a `CONFIRMED > 95%` ao longo de
 * 90 dias, e em 90 dias esta lógica muda pelo menos uma vez. Sem a versão,
 * medições feitas por regras diferentes entram no mesmo denominador e o número
 * que autoriza a Allva a agir sozinha vira média de duas medidas distintas.
 *
 * Bump: mudança em limiar, em fórmula de delta ou em confiança. Confounder novo
 * **não** bumpa — ele acrescenta contexto sem mudar o número medido.
 */
export const MEASUREMENT_VERSION = 'measure-1.0.0';

/**
 * O que se sabe contra o número (D6). São detectáveis com o que o sync coleta;
 * o que não é detectável não entra na lista, porque uma lista que finge cobrir
 * tudo é pior que uma curta e honesta.
 */
export type ConfounderCode =
  /** A série quebrou dentro da janela pós (§12.5) — as duas pontas não são comparáveis. */
  | 'SERIES_DISCONTINUITY'
  /** Menos dias observados que a janela declarada: a medição é sobre parte dela. */
  | 'PARTIAL_OBSERVATION'
  /** A ação recriou o anúncio; a janela pós atravessa uma sucessão de linhagem (§3.6). */
  | 'LINEAGE_SUCCESSION'
  /** Outras escritas nossas sobre o mesmo anúncio dentro da janela. */
  | 'CONCURRENT_ACTIONS'
  /** O anúncio saiu de ativo por mão de terceiros — o efeito não é só nosso. */
  | 'EXTERNAL_STATUS_CHANGE'
  /** Sem gasto na janela pré: não há linha de base contra a qual comparar. */
  | 'NO_PRE_BASELINE';

export type Confounder = { code: ConfounderCode; detail: string };

export type OutcomeVerdictValue =
  | 'IMPROVED'
  | 'UNCHANGED'
  | 'WORSENED'
  | 'INCONCLUSIVE';

export type MeasurementWindow = {
  spendBase: number;
  revenueBase: number;
  conversions: number;
  aiScore: number | null;
};

export type MeasurementInput = {
  /** DEC-6 — declarado na geração, nunca escolhido aqui. */
  kind: OutcomeDeltaKind;
  windowDays: number;
  pre: MeasurementWindow;
  post: MeasurementWindow;
  observedDays: number;
  seriesDiscontinuity: string | null;
  lineageAdCount: number;
  externalStatusChange: boolean;
  concurrentActions: number;
};

export type Measurement = {
  /**
   * **Sempre no sentido "positivo é melhor"**, qualquer que seja o kind.
   *
   * `SPEND_AVOIDED` mede gasto que deixou de sair, `CPA_DELTA` mede custo que
   * caiu — os dois são subtrações invertidas em relação a `REVENUE_DELTA`.
   * Deixar o sinal seguir a aritmética crua faria a tela precisar saber, por
   * tipo, se menos é bom; e o dia em que ela esquecer, o produto celebra uma
   * piora.
   */
  observedDelta: number | null;
  verdict: OutcomeVerdictValue;
  confidence: number;
  confounders: Confounder[];
  /**
   * Contexto, **fora** das métricas de acurácia de P8 (DEC-6). Uma recomendação
   * com estimativa de economia e de eficiência produz **uma** medição; as demais
   * grandezas viajam aqui para quem quiser olhar, sem entrar no denominador.
   */
  secondaryDeltas: Record<string, number | null>;
};

/**
 * Mudança relativa a partir da qual o veredito deixa de ser `UNCHANGED`.
 *
 * 5% não é arbitrário no sentido que importa: abaixo disso, a variação normal de
 * leilão entre duas semanas quaisquer já explica o número, e declarar `IMPROVED`
 * ali encheria o dataset de P8 de acertos que são ruído. É calibrável quando
 * houver histórico — e a calibração bumpa `MEASUREMENT_VERSION`.
 */
const RELATIVE_THRESHOLD = 0.05;

/** Score é 0..100: três pontos é a menor diferença que alguém defenderia. */
const SCORE_POINT_THRESHOLD = 3;

/** Abaixo desta fração da janela, a medição é sobre pouca coisa. */
const MIN_OBSERVED_RATIO = 0.6;

export function measureOutcome(input: MeasurementInput): Measurement {
  const confounders = detectConfounders(input);
  const secondaryDeltas = buildSecondaryDeltas(input);

  const observedRatio =
    input.windowDays > 0
      ? Math.min(1, input.observedDays / input.windowDays)
      : 0;

  /**
   * **Sem observação suficiente, não há veredito** (P7).
   *
   * Uma janela pós com dois dias de série não diz que o anúncio melhorou nem
   * que piorou — diz que não olhamos. Emitir `UNCHANGED` aqui seria afirmar
   * estabilidade a partir de silêncio, que é o modo de falha que §10.7 passo 1 e
   * a regra "ausência de dado nunca é evidência" existem para impedir.
   */
  if (observedRatio < MIN_OBSERVED_RATIO) {
    return {
      observedDelta: null,
      verdict: 'INCONCLUSIVE',
      confidence: 0,
      confounders,
      secondaryDeltas,
    };
  }

  const delta = deltaFor(input);

  if (delta === null) {
    return {
      observedDelta: null,
      verdict: 'INCONCLUSIVE',
      confidence: 0,
      confounders,
      secondaryDeltas,
    };
  }

  return {
    observedDelta: round4(delta.value),
    verdict: verdictFor(delta),
    confidence: confidenceFor({ observedRatio, confounders }),
    confounders,
    secondaryDeltas,
  };
}

type Delta = {
  value: number;
  /** A régua contra a qual `value` é grande ou pequeno. */
  reference: number;
  /** `RELATIVE` compara com a base; `ABSOLUTE` compara com um limiar em pontos. */
  scale: 'RELATIVE' | 'ABSOLUTE';
};

/**
 * O delta **primário**, um por recomendação (DEC-6).
 *
 * `null` quando a grandeza não existe nas duas janelas — CPA sem conversão não é
 * "CPA infinito", é CPA não medido, e tratá-lo como um número faria toda pausa
 * de anúncio sem conversão aparecer como melhoria astronômica.
 */
function deltaFor(input: MeasurementInput): Delta | null {
  const { pre, post } = input;

  switch (input.kind) {
    case 'SPEND_AVOIDED': {
      if (pre.spendBase <= 0) return null;
      return {
        value: pre.spendBase - post.spendBase,
        reference: pre.spendBase,
        scale: 'RELATIVE',
      };
    }

    case 'REVENUE_DELTA': {
      // Receita pré zero é ponto de partida legítimo — escalar um anúncio que
      // ainda não vendeu é exatamente o caso em que a receita nova é o efeito.
      // A régua vira o gasto pré, que existe sempre que houve veiculação.
      const reference = pre.revenueBase > 0 ? pre.revenueBase : pre.spendBase;
      if (reference <= 0) return null;
      return {
        value: post.revenueBase - pre.revenueBase,
        reference,
        scale: 'RELATIVE',
      };
    }

    case 'CPA_DELTA': {
      const preCpa = ratio(pre.spendBase, pre.conversions);
      const postCpa = ratio(post.spendBase, post.conversions);
      if (preCpa === null || postCpa === null) return null;
      return { value: preCpa - postCpa, reference: preCpa, scale: 'RELATIVE' };
    }

    case 'SCORE_DELTA': {
      if (pre.aiScore === null || post.aiScore === null) return null;
      return {
        value: post.aiScore - pre.aiScore,
        reference: SCORE_POINT_THRESHOLD,
        scale: 'ABSOLUTE',
      };
    }
  }
}

function verdictFor(delta: Delta): OutcomeVerdictValue {
  const threshold =
    delta.scale === 'ABSOLUTE'
      ? SCORE_POINT_THRESHOLD
      : Math.abs(delta.reference) * RELATIVE_THRESHOLD;

  if (delta.value > threshold) return 'IMPROVED';
  if (delta.value < -threshold) return 'WORSENED';
  return 'UNCHANGED';
}

/**
 * Confiança é **cobertura descontada pelo que se sabe contra o número**.
 *
 * Cada confounder tira 0,15, com piso em 0,1: um número medido sobre uma janela
 * atravessada por descontinuidade, sucessão de linhagem e ação concorrente
 * continua sendo um número — só não é um sobre o qual se decide automação.
 * Zerar a confiança seria equivalente a apagar a linha, e apagar perde o
 * histórico que §20-H3 precisa acumular.
 */
function confidenceFor(input: {
  observedRatio: number;
  confounders: Confounder[];
}): number {
  const penalty = input.confounders.length * 0.15;
  return round4(Math.max(0.1, input.observedRatio - penalty));
}

function detectConfounders(input: MeasurementInput): Confounder[] {
  const found: Confounder[] = [];

  if (input.seriesDiscontinuity) {
    found.push({
      code: 'SERIES_DISCONTINUITY',
      detail: `A série quebrou dentro da janela pós: ${input.seriesDiscontinuity}.`,
    });
  }

  if (input.observedDays < input.windowDays) {
    found.push({
      code: 'PARTIAL_OBSERVATION',
      detail: `${input.observedDays} de ${input.windowDays} dias observados na janela pós.`,
    });
  }

  if (input.lineageAdCount > 1) {
    found.push({
      code: 'LINEAGE_SUCCESSION',
      detail: `A janela pós atravessa ${input.lineageAdCount} anúncios da mesma linhagem.`,
    });
  }

  if (input.concurrentActions > 0) {
    found.push({
      code: 'CONCURRENT_ACTIONS',
      detail: `${input.concurrentActions} outra(s) escrita(s) sobre o mesmo anúncio dentro da janela.`,
    });
  }

  if (input.externalStatusChange) {
    found.push({
      code: 'EXTERNAL_STATUS_CHANGE',
      detail: 'O anúncio mudou de status por fora da Allva dentro da janela.',
    });
  }

  if (input.pre.spendBase <= 0) {
    found.push({
      code: 'NO_PRE_BASELINE',
      detail: 'A janela pré não tem gasto: não há linha de base a comparar.',
    });
  }

  return found;
}

/** Todas as grandezas, para quem quiser olhar — nenhuma delas entra em P8. */
function buildSecondaryDeltas(
  input: MeasurementInput,
): Record<string, number | null> {
  const { pre, post } = input;
  const preCpa = ratio(pre.spendBase, pre.conversions);
  const postCpa = ratio(post.spendBase, post.conversions);

  return {
    spendBase: round4(post.spendBase - pre.spendBase),
    revenueBase: round4(post.revenueBase - pre.revenueBase),
    conversions: post.conversions - pre.conversions,
    cpaBase:
      preCpa === null || postCpa === null ? null : round4(preCpa - postCpa),
    roas: round4(
      (ratio(post.revenueBase, post.spendBase) ?? 0) -
        (ratio(pre.revenueBase, pre.spendBase) ?? 0),
    ),
    aiScore:
      pre.aiScore === null || post.aiScore === null
        ? null
        : round4(post.aiScore - pre.aiScore),
  };
}

/** Divisão que devolve `null` no denominador zero, nunca `Infinity`. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
