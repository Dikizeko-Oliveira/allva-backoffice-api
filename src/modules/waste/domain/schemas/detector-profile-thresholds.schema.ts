import { z } from 'zod';

/**
 * `DetectorProfile.thresholds` — campo `Json` normativo (E1, G15).
 *
 * Os limiares saem do corpo dos detectores e viram configuração versionada
 * (§10.4). A distinção que o schema sustenta: **mudança de limiar não é mudança
 * de lógica** — só a segunda dispara `SUPERSEDED_BY_DETECTOR` e invalida os
 * achados abertos.
 */
export const DETECTOR_PROFILE_THRESHOLDS_SCHEMA_VERSION = 1;

const detectorThresholdSchema = z.object({
  /** Valores nomeados do detector, ex.: `{ minSpendBase: 50, maxCpaRatio: 1.5 }`. */
  values: z.record(z.string(), z.number()),
  /** Evidência mínima abaixo da qual o detector devolve `null` (P7). */
  minimumEvidence: z.object({
    days: z.number().int().positive(),
    impressions: z.number().int().nonnegative().optional(),
    spendBase: z.number().nonnegative().optional(),
    /**
     * A2-S5, aditivo (E1). §10.5 declara "≥ 3 conversões no anúncio" como
     * evidência mínima de `HIGH_CPA`; sem o campo, essa condição viveria no
     * corpo do detector — exatamente o que §10.4 tira de lá. Opcional, então
     * `schemaVersion` **não** bumpa: perfil gravado antes continua válido.
     */
    conversions: z.number().int().nonnegative().optional(),
  }),
  /** Detectores destrutivos só disparam sobre janela `MATURE` (§8.9). */
  requiresMaturity: z.enum(['IMMATURE', 'SETTLING', 'MATURE']),
});

export const detectorProfileThresholdsSchema = z.object({
  schemaVersion: z.literal(DETECTOR_PROFILE_THRESHOLDS_SCHEMA_VERSION),
  detectors: z.record(z.string(), detectorThresholdSchema),
});

export type DetectorProfileThresholds = z.infer<
  typeof detectorProfileThresholdsSchema
>;
