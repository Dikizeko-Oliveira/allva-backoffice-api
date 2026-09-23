import {
  DETECTOR_PROFILE_THRESHOLDS_SCHEMA_VERSION,
  DetectorProfileThresholds,
  detectorProfileThresholdsSchema,
} from './schemas/detector-profile-thresholds.schema';
import type { FindingType } from './contracts/finding-catalog';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';

/**
 * §10.4 — os limiares saem do corpo dos detectores e viram **configuração
 * versionada**.
 *
 * É isso que torna P7 verificável ("por que este anúncio foi marcado?") e P8
 * possível (calibrar sem deploy, comparar configurações lado a lado). `WasteItem`
 * grava `detectorProfileVersion` **além** de `detectorVersion`, e a distinção
 * entre os dois é normativa:
 *
 * > **Mudança de profile não é mudança de detector.** Trocar um limiar não
 * > dispara `SUPERSEDED_BY_DETECTOR` — o achado é o mesmo, o corte é que mudou.
 * > Só a troca de `detectorVersion` (mudança de lógica) tem esse efeito.
 */

export type EvidenceGate = {
  /** Dias de série com observação, o mínimo absoluto de qualquer achado. */
  days: number;
  impressions?: number;
  /** Sempre em **moeda-base** (M1): limiar em moeda de conta não é comparável. */
  spendBase?: number;
  /** §10.5 declara "≥ 3 conversões no anúncio" para `HIGH_CPA`. */
  conversions?: number;
};

export type ThresholdSet = {
  values: Record<string, number>;
  minimumEvidence: EvidenceGate;
  requiresMaturity: DataMaturity;
};

export type DetectorProfile = {
  version: string;
  /** `null` = padrão global. */
  organizationId: string | null;
  thresholds: Record<FindingType, ThresholdSet>;
  /** Origem: análise de base, calibração, decisão de produto. */
  provenance: string;
  effectiveFrom: Date;
};

/** A versão que `OrganizationAdsSettings.activeDetectorProfileVersion` aponta. */
export const DEFAULT_DETECTOR_PROFILE_VERSION = 'waste-thresholds-v1';

/**
 * O multiplicador da queda para linha de base da conta (DEC-3).
 *
 * Vive em `values` de cada detector que compara contra benchmark, e não como
 * constante solta, porque **é limiar**: calibrar a agressividade do fallback sem
 * deploy é exatamente o que §10.4 existe para permitir. Com menos de 3 pares o
 * benchmark é de outro público e outro leilão — 1,5× é o preço declarado dessa
 * imprecisão, e a alternativa (exigir 3 pares para disparar) silenciaria contas
 * inteiras, porque um anúncio por ad set é a estrutura mais comum onde
 * desperdício dói mais.
 */
export const BENCHMARK_FALLBACK_MULTIPLIER = 1.5;

/**
 * O perfil padrão global — **os limiares de §10.5, como dado**.
 *
 * Ancorados em faixas de mercado, não em calibração contra base real: não há
 * base ainda. É por isso que a `provenance` diz o que diz. Quando houver dado
 * para calibrar (P8, §20-H3), a mudança é uma linha nova em `detector_profiles`
 * com outra versão — nunca uma edição deste literal, que apagaria a explicação
 * dos achados já gravados.
 */
export const DEFAULT_DETECTOR_THRESHOLDS: Record<FindingType, ThresholdSet> = {
  // Origina `PAUSE_UNDERPERFORMING_AD`, a ação mais destrutiva e mais frequente
  // do catálogo: `MATURE` não é conservadorismo, é a diferença entre pausar um
  // anúncio ruim e pausar um anúncio cuja conversão ainda não foi atribuída.
  ZERO_CONVERSIONS: {
    values: {
      minSpendBase: 50,
      medianCpaMultiple: 3,
      fallbackMultiplier: BENCHMARK_FALLBACK_MULTIPLIER,
    },
    minimumEvidence: { days: 5, spendBase: 50 },
    requiresMaturity: 'MATURE',
  },
  LOW_ROAS: {
    values: { maxRoas: 1 },
    minimumEvidence: { days: 3, spendBase: 50, conversions: 1 },
    requiresMaturity: 'MATURE',
  },
  // O nominal é 2× a mediana do ad set; com menos de 3 pares o corte vira 3× a
  // mediana da conta, que é o mesmo 2× multiplicado pelo fallback de DEC-3 —
  // e é assim que §10.5 e DEC-3 dizem a mesma coisa em vez de duas.
  HIGH_CPA: {
    values: {
      cpaMultiple: 2,
      fallbackMultiplier: BENCHMARK_FALLBACK_MULTIPLIER,
    },
    minimumEvidence: { days: 3, conversions: 3 },
    requiresMaturity: 'MATURE',
  },
  LOW_CTR: {
    values: {
      floorPercentile: 25,
      referencePercentile: 50,
      fallbackMultiplier: BENCHMARK_FALLBACK_MULTIPLIER,
    },
    minimumEvidence: { days: 3, impressions: 1000 },
    requiresMaturity: 'SETTLING',
  },
  // `fatigueScore` é 0..1 na escala nativa da calculadora (§12.2), e é a escala
  // nativa que o detector consome — normalizar antes de comparar trocaria a
  // régua sem trocar o limiar.
  CREATIVE_FATIGUE: {
    values: { minFatigueScore: 0.65, incurredFactor: 0.5 },
    minimumEvidence: { days: 7 },
    requiresMaturity: 'SETTLING',
  },
  NEGATIVE_FEEDBACK: {
    values: { minRisk: 60, incurredFactor: 0.4 },
    minimumEvidence: { days: 3 },
    requiresMaturity: 'SETTLING',
  },
  LEARNING_INSTABILITY: {
    values: { maxStability: 40, minSpendBase: 50, incurredFactor: 0.25 },
    minimumEvidence: { days: 7, spendBase: 50 },
    requiresMaturity: 'SETTLING',
  },
  // DEC-4: frequência média 7d + slope positivo + impressões estáveis ou em
  // queda. **Não** reach estagnado — reach diário não soma em reach semanal.
  AUDIENCE_SATURATION: {
    values: {
      minFrequency: 3.5,
      minSlope: 0,
      maxImpressionGrowth: 0.05,
      incurredFactor: 0.35,
    },
    minimumEvidence: { days: 7 },
    requiresMaturity: 'SETTLING',
  },
  // DEC-5: mesmo `contentHash` no mesmo ad set, ambos com gasto relevante.
  OVERLAPPING_DELIVERY: {
    values: { minSpendBase: 50 },
    minimumEvidence: { days: 3, spendBase: 50 },
    requiresMaturity: 'SETTLING',
  },
  // A única oportunidade. O piso de score é alto de propósito: a recomendação
  // derivada (`SCALE_WINNING_AD`) é a única que **aumenta** gasto.
  BUDGET_STARVATION: {
    values: { minAiScore: 70, impressionsPercentile: 10, minPeers: 3 },
    minimumEvidence: { days: 7 },
    requiresMaturity: 'SETTLING',
  },
};

export const DEFAULT_DETECTOR_PROFILE: DetectorProfile = {
  version: DEFAULT_DETECTOR_PROFILE_VERSION,
  organizationId: null,
  thresholds: DEFAULT_DETECTOR_THRESHOLDS,
  provenance:
    'Faixas de mercado (§10.5). Não calibrado contra base real — a calibração de P8 ' +
    'publica uma versão nova, nunca edita esta.',
  effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
};

/** A forma serializável do perfil, validada por schema versionado (E1, G15). */
export function toThresholdsJson(
  thresholds: Record<FindingType, ThresholdSet>,
): DetectorProfileThresholds {
  return detectorProfileThresholdsSchema.parse({
    schemaVersion: DETECTOR_PROFILE_THRESHOLDS_SCHEMA_VERSION,
    detectors: thresholds,
  });
}

/**
 * Lê o perfil persistido, **caindo para o padrão detector a detector**.
 *
 * Uma organização que calibrou só `HIGH_CPA` não pode perder os outros nove: o
 * merge por chave é o que permite calibrar um limiar sem republicar o catálogo
 * inteiro. Perfil ilegível cai inteiro para o padrão e **declara** a versão
 * padrão — gravar `detectorProfileVersion` de um perfil que não foi aplicado
 * seria mentir na procedência do achado.
 */
export function resolveProfile(input: {
  version: string;
  organizationId: string | null;
  thresholds: unknown;
  provenance?: string | null;
  effectiveFrom?: Date | null;
}): DetectorProfile {
  const parsed = detectorProfileThresholdsSchema.safeParse(input.thresholds);

  if (!parsed.success) return DEFAULT_DETECTOR_PROFILE;

  const merged = { ...DEFAULT_DETECTOR_THRESHOLDS };

  for (const [type, set] of Object.entries(parsed.data.detectors)) {
    if (!(type in merged)) continue;
    const key = type as FindingType;
    merged[key] = {
      values: { ...merged[key].values, ...set.values },
      minimumEvidence: set.minimumEvidence,
      requiresMaturity: set.requiresMaturity,
    };
  }

  return {
    version: input.version,
    organizationId: input.organizationId,
    thresholds: merged,
    provenance: input.provenance ?? DEFAULT_DETECTOR_PROFILE.provenance,
    effectiveFrom:
      input.effectiveFrom ?? DEFAULT_DETECTOR_PROFILE.effectiveFrom,
  };
}
