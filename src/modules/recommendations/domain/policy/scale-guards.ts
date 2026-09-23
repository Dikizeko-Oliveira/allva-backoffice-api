import type { RecommendationSignals } from '../recommendation-plan';

/**
 * As **seis guardas de `SCALE_WINNING_AD`** (§9.3).
 *
 * É a única recomendação que **aumenta** gasto — sob P5, a que exige mais
 * evidência. E o motivo de precisar de seis guardas em vez de um limiar de score
 * está na própria composição do número:
 *
 * > O `aiScore` inclui fadiga com peso 0,15 **invertido**. Um anúncio com
 * > attention 90, audienceFit 90 e fatigue 0,70 cruza os 75 pontos. É o perfil
 * > do criativo campeão em fim de vida — e aumentar orçamento nele acelera
 * > exatamente o que o está matando.
 *
 * Bloqueio **não some em silêncio**: cada guarda devolve o motivo, a recomendação
 * é gerada com `blockedReason` visível, e a taxa de bloqueio por guarda é sinal
 * de calibração para P8.
 */

export type ScaleGuardVerdict =
  | { allowed: true; blockedReason: null }
  | { allowed: false; blockedReason: string };

const ALLOWED: ScaleGuardVerdict = { allowed: true, blockedReason: null };

function blocked(reason: string): ScaleGuardVerdict {
  return { allowed: false, blockedReason: reason };
}

export type ScaleGuard = {
  name: string;
  evaluate(signals: RecommendationSignals): ScaleGuardVerdict;
};

/**
 * Fadiga — a guarda que a composição do score torna necessária.
 *
 * Bloqueia no valor **e** na tendência: um criativo com fadiga 0,45 subindo há
 * uma semana chega a 0,5 antes de o orçamento novo ser gasto. `delta7d` negativo
 * com fadiga presente é a assinatura disso, e é por isso que a queda de score
 * conta como fadiga em alta mesmo abaixo do corte absoluto.
 */
export const fatigueGuard: ScaleGuard = {
  name: 'FATIGUE',
  evaluate(signals) {
    const fatigue = signals.score?.fatigueScore;
    if (fatigue === null || fatigue === undefined) return ALLOWED;

    if (fatigue >= signals.thresholds.scaleMaxFatigue) {
      return blocked(
        `Candidato a escala retido por fadiga: ${fatigue.toFixed(2)} ` +
          `(corte ${signals.thresholds.scaleMaxFatigue}).`,
      );
    }

    const delta = signals.score?.delta7d;
    if (delta !== null && delta !== undefined && delta < 0 && fatigue > 0) {
      return blocked(
        `Candidato a escala retido por fadiga em alta: score caiu ${Math.abs(delta).toFixed(1)} ` +
          'ponto(s) em 7 dias com fadiga presente.',
      );
    }

    return ALLOWED;
  },
};

/**
 * Saturação — o achado aberto no anúncio **ou no conjunto**.
 *
 * O conjunto conta porque `AUDIENCE_SATURATION` é de escopo `AD_SET` (DEC-4):
 * ele é atribuído a um anúncio só, e olhar apenas o anúncio atribuído deixaria
 * os outros do mesmo público passarem pela guarda.
 */
export const saturationGuard: ScaleGuard = {
  name: 'SATURATION',
  evaluate(signals) {
    const onAd = signals.findings.some(
      (finding) => finding.type === 'AUDIENCE_SATURATION',
    );
    const onAdSet = signals.adSetFindingTypes.includes('AUDIENCE_SATURATION');

    if (onAd || onAdSet) {
      return blocked(
        'Candidato a escala retido por saturação de público ' +
          `${onAd ? 'neste anúncio' : 'no conjunto'}.`,
      );
    }

    return ALLOWED;
  },
};

/** Frequência acima do limiar do `DetectorProfile`, mesmo sem achado aberto. */
export const frequencyGuard: ScaleGuard = {
  name: 'FREQUENCY',
  evaluate(signals) {
    const frequency = signals.ad.frequency;
    if (frequency === null) return ALLOWED;

    if (frequency > signals.thresholds.saturationFrequency) {
      return blocked(
        `Candidato a escala retido por frequência ${frequency.toFixed(2)} ` +
          `(limiar ${signals.thresholds.saturationFrequency}).`,
      );
    }

    return ALLOWED;
  },
};

/**
 * Confiança e cobertura — os pisos de §12.4 para `SCALE_WINNING_AD`.
 *
 * São os mais altos da tabela, e a razão é uma frase: **anúncio novo não é
 * anúncio campeão**. Um score alto com confiança baixa descreve ignorância, não
 * desempenho.
 */
export const confidenceGuard: ScaleGuard = {
  name: 'CONFIDENCE',
  evaluate(signals) {
    const score = signals.score;
    if (!score) {
      return blocked('Candidato a escala retido: o anúncio não tem AI Score.');
    }

    if (score.aiConfidence < signals.thresholds.scaleMinConfidence) {
      return blocked(
        `Candidato a escala retido por confiança ${score.aiConfidence.toFixed(2)} ` +
          `(piso ${signals.thresholds.scaleMinConfidence}) — anúncio novo não é anúncio campeão.`,
      );
    }

    if (score.coverageRatio < signals.thresholds.scaleMinCoverageRatio) {
      return blocked(
        `Candidato a escala retido por cobertura ${score.coverageRatio.toFixed(2)} ` +
          `(piso ${signals.thresholds.scaleMinCoverageRatio}).`,
      );
    }

    return ALLOWED;
  },
};

/**
 * Maturidade — **ROAS é re-declarado** (§8.9).
 *
 * Escalar sobre janela imatura é aumentar orçamento com base num retorno que a
 * plataforma ainda vai reescrever, e a reescrita costuma ser para baixo depois
 * do pico de atribuição.
 */
export const maturityGuard: ScaleGuard = {
  name: 'MATURITY',
  evaluate(signals) {
    if (signals.ad.dataMaturity === 'MATURE') return ALLOWED;

    return blocked(
      `Candidato a escala retido por maturidade ${signals.ad.dataMaturity ?? 'sem observação'}: ` +
        'ROAS ainda vai ser re-declarado.',
    );
  },
};

/** Escalar em aprendizado instável o **reinicia** — e o gasto novo paga isso. */
export const stabilityGuard: ScaleGuard = {
  name: 'STABILITY',
  evaluate(signals) {
    const stability = signals.score?.learningStability;
    if (stability === null || stability === undefined) return ALLOWED;

    if (stability < signals.thresholds.minLearningStability) {
      return blocked(
        `Candidato a escala retido por aprendizado instável: ${stability.toFixed(0)}/100 ` +
          `(piso ${signals.thresholds.minLearningStability}).`,
      );
    }

    return ALLOWED;
  },
};

/**
 * As seis, na ordem em que são avaliadas.
 *
 * A ordem importa para a mensagem, não para o veredito: o primeiro bloqueio é o
 * que o usuário lê, e fadiga e saturação explicam melhor "por que não escalar
 * este campeão" do que um piso de confiança.
 */
export const SCALE_GUARDS: readonly ScaleGuard[] = [
  fatigueGuard,
  saturationGuard,
  frequencyGuard,
  confidenceGuard,
  maturityGuard,
  stabilityGuard,
];

/** O primeiro bloqueio encontrado, ou liberação. */
export function evaluateScaleGuards(
  signals: RecommendationSignals,
): ScaleGuardVerdict {
  for (const guard of SCALE_GUARDS) {
    const verdict = guard.evaluate(signals);
    if (!verdict.allowed) return verdict;
  }

  return ALLOWED;
}
