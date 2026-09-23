import {
  MINIMUM_MATURITY_BY_FINDING,
  satisfiesMaturity,
  type DataMaturity,
} from 'src/modules/sync/domain/data-maturity';
import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import {
  describeOptimization,
  judgesConversion,
} from 'src/modules/integrations/domain/entities/optimization-target';
import type { FindingType } from './contracts/finding-catalog';
import type {
  AdWindowAggregate,
  Insufficiency,
  Percentiles,
} from './detection-context';
import type { DetectorProfile } from './detector-profile';
import type { WasteEvidence } from './schemas/waste-evidence.schema';
import { WASTE_EVIDENCE_SCHEMA_VERSION } from './schemas/waste-evidence.schema';

/**
 * Evidência mínima (§10.3, P7).
 *
 * *"Todo detector declara `minimumEvidence`. Abaixo dela devolve `null` e a
 * insuficiência é **reportada**, nunca convertida em ausência de problema."*
 *
 * A distinção não é retórica: "não há desperdício neste anúncio" e "não temos
 * dado suficiente para dizer" levam a decisões opostas, e um `null` silencioso
 * faz o usuário ler a segunda como a primeira. Por isso o portão devolve o
 * motivo, e o motivo sobe até `meta.evidenceSufficiency` da resposta.
 */

/**
 * Os quatro detectores que consomem componentes do `AdScore`.
 *
 * É esta lista que torna `waste` dependente de `ad-scoring` no grafo de §5.3 — e
 * a dependência é do **port de leitura**, nunca do cálculo (D2).
 */
export const COMPONENT_BY_FINDING: Readonly<
  Partial<Record<FindingType, string>>
> = {
  CREATIVE_FATIGUE: 'fatigue',
  NEGATIVE_FEEDBACK: 'negativeFeedbackRisk',
  LEARNING_INSTABILITY: 'learningStability',
  // Consome o composto, não um componente: a guarda é a existência do score.
  BUDGET_STARVATION: '',
};

/**
 * A maturidade exigida: o **maior** entre o perfil e a tabela de §8.9.
 *
 * O perfil é configuração por organização e pode endurecer o corte; não pode
 * afrouxá-lo. §8.9 é invariante de segurança — `ZERO_CONVERSIONS` origina
 * `PAUSE_UNDERPERFORMING_AD`, e disparar sobre janela imatura é recomendar
 * pausar um anúncio que converteu. Deixar a configuração baixar esse piso seria
 * pôr a proteção mais destrutiva do catálogo atrás de um campo `Json`.
 */
export function requiredMaturity(
  type: FindingType,
  profile: DetectorProfile,
): DataMaturity {
  const configured = profile.thresholds[type].requiresMaturity;
  const normative = MINIMUM_MATURITY_BY_FINDING[type];
  if (!normative) return configured;

  return satisfiesMaturity(configured, normative) ? configured : normative;
}

export type GateInput = {
  type: FindingType;
  ad: AdWindowAggregate;
  score: AdScoreView | null;
  profile: DetectorProfile;
  /**
   * `DATA_MATURITY_GATING_ENABLED`. Existe para desligar em investigação, não
   * para adiar a proteção — e o desligamento é declarado na procedência.
   */
  maturityGatingEnabled: boolean;
};

/**
 * Avalia o portão **antes** de o detector rodar. `null` = pode rodar.
 *
 * Fica fora dos detectores de propósito. Dentro de cada um, a verificação seria
 * dez cópias da mesma regra e a décima primeira nasceria sem ela; aqui é um
 * caminho só, e o teste percorre o registro inteiro — um detector novo que
 * esqueça a evidência mínima não tem como esquecer, porque não é ele que a
 * aplica.
 */
export function evaluateGate(input: GateInput): Insufficiency | null {
  const { type, ad, profile } = input;
  const gate = profile.thresholds[type].minimumEvidence;
  const adId = ad.adId;

  // Primeiro o objetivo: um anúncio de alcance não "espera evidência" de
  // conversão — ele nunca vai tê-la, e dizer "faltam 3 conversões" a quem
  // otimiza para impressão seria mandar esperar pelo que não vem.
  const objective = objectiveGate(type, ad);
  if (objective) return objective;

  if (ad.days < gate.days) {
    return {
      adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'AWAITING_DAYS',
      current: ad.days,
      required: gate.days,
      reason: `Série de ${ad.days} dia(s); o mínimo declarado é ${gate.days}.`,
    };
  }

  if (gate.impressions !== undefined && ad.impressions < gate.impressions) {
    return {
      adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'AWAITING_IMPRESSIONS',
      current: ad.impressions,
      required: gate.impressions,
      reason: `${ad.impressions} impressões; o mínimo declarado é ${gate.impressions}.`,
    };
  }

  if (gate.spendBase !== undefined && ad.spendBase < gate.spendBase) {
    return {
      adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'AWAITING_SPEND',
      current: ad.spendBase,
      required: gate.spendBase,
      reason: `Gasto de ${ad.spendBase.toFixed(2)} ${ad.baseCurrency}; o mínimo declarado é ${gate.spendBase}.`,
    };
  }

  if (gate.conversions !== undefined && ad.conversions < gate.conversions) {
    return {
      adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'AWAITING_CONVERSIONS',
      current: ad.conversions,
      required: gate.conversions,
      reason: `${ad.conversions} conversão(ões); o mínimo declarado é ${gate.conversions}.`,
    };
  }

  const component = COMPONENT_BY_FINDING[type];

  if (component !== undefined) {
    if (!input.score) {
      return {
        adId,
        type,
        sufficiency: 'MISSING_SCORE',
        code: 'AWAITING_SCORE',
        reason: 'O anúncio ainda não tem AI Score calculado.',
      };
    }

    // §12.4: componente indisponível ⇒ o detector devolve `null`. Um anúncio de
    // Search não tem frequência, e marcá-lo como fatigado a partir do fallback
    // da calculadora seria inventar a evidência que a plataforma não dá.
    if (component && input.score.components[component]?.available !== true) {
      return {
        adId,
        type,
        sufficiency: 'MISSING_SCORE',
        code: 'COMPONENT_UNAVAILABLE',
        reason: `O componente ${component} não é mensurável neste anúncio.`,
      };
    }
  }

  if (input.maturityGatingEnabled) {
    const required = requiredMaturity(type, profile);
    if (!satisfiesMaturity(ad.dataMaturity, required)) {
      return {
        adId,
        type,
        sufficiency: 'INSUFFICIENT',
        code: 'AWAITING_MATURITY',
        reason:
          `Janela ${ad.dataMaturity ?? 'sem observação'}; ` +
          `${type} só dispara sobre janela ${required} (§8.9).`,
      };
    }
  }

  return null;
}

/**
 * Os detectores que só fazem sentido sobre anúncio otimizado para conversão.
 *
 * `ZERO_CONVERSIONS` e `HIGH_CPA` contam conversão; `LOW_ROAS` divide receita
 * pelo gasto, e receita só existe onde o evento carrega valor. Os demais —
 * CTR, fadiga, feedback negativo, aprendizado, saturação, entrega sobreposta,
 * oportunidade — valem para qualquer objetivo.
 */
export const CONVERSION_DEPENDENT_FINDINGS: ReadonlySet<FindingType> = new Set([
  'ZERO_CONVERSIONS',
  'LOW_ROAS',
  'HIGH_CPA',
]);

/**
 * O portão de objetivo — **antes** de qualquer outro, e fora dos detectores
 * pelo mesmo motivo da evidência mínima: dentro de cada um seriam três cópias,
 * e o quarto detector de conversão nasceria sem ele.
 *
 * `UNKNOWN` barra: sem saber o objetivo, cobrar conversão é apostar no falso
 * positivo que motivou este portão.
 */
function objectiveGate(
  type: FindingType,
  ad: AdWindowAggregate,
): Insufficiency | null {
  if (!CONVERSION_DEPENDENT_FINDINGS.has(type)) return null;

  const target = ad.optimization;
  if (judgesConversion(target)) return null;

  if (target.optimizationClass === 'UNKNOWN') {
    return {
      adId: ad.adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'OBJECTIVE_UNKNOWN',
      reason:
        'O objetivo de otimização deste anúncio ainda não foi identificado; ' +
        'conversão não é julgada até o próximo sync lê-lo.',
    };
  }

  if (target.optimizationClass !== 'CONVERSION') {
    return {
      adId: ad.adId,
      type,
      sufficiency: 'INSUFFICIENT',
      code: 'OBJECTIVE_NOT_CONVERSION',
      reason:
        `O anúncio otimiza para ${describeOptimization(target)}; ` +
        'conversão só é julgada em anúncio otimizado para conversão.',
    };
  }

  return {
    adId: ad.adId,
    type,
    sufficiency: 'INSUFFICIENT',
    code: 'CONVERSION_NOT_MEASURABLE',
    reason:
      `O anúncio otimiza para ${describeOptimization(target)}, e a plataforma ` +
      'não reporta esse evento separado dos outros; contar seria inventar o número.',
  };
}

/**
 * Monta a evidência persistida — limiar aplicado e valor observado, lado a lado.
 *
 * P7: um achado sem os limiares que o dispararam e sem o valor observado não é
 * diagnóstico, é opinião. O schema versionado é o que impede o detector de
 * gravar "confie em mim".
 */
export function buildEvidence(input: {
  thresholds: Record<string, number>;
  observed: Record<string, number>;
  scopeLevel: WasteEvidence['scopeLevel'];
  relatedAdIds?: string[];
  attributionRule?: string | null;
  sampleSize?: number;
  benchmark?: {
    kind: 'AD_SET_PEERS' | 'ACCOUNT_BASELINE';
    pairs: number;
    median: number | null;
  };
}): WasteEvidence {
  return {
    schemaVersion: WASTE_EVIDENCE_SCHEMA_VERSION,
    thresholds: input.thresholds,
    observed: input.observed,
    scopeLevel: input.scopeLevel,
    relatedAdIds: input.relatedAdIds ?? [],
    attributionRule: input.attributionRule ?? null,
    ...(input.sampleSize !== undefined ? { sampleSize: input.sampleSize } : {}),
    ...(input.benchmark ? { benchmark: input.benchmark } : {}),
  };
}

/** Açúcar: o percentil pedido, ou `null` quando a amostra não o sustenta. */
export function at(percentiles: Percentiles, p: 10 | 25 | 50 | 75) {
  return percentiles[`p${p}` as keyof Percentiles];
}
