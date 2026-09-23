import { z } from 'zod';

/**
 * `Recommendation.impacts` — campo `Json` normativo (E1, G15).
 *
 * Guarda **apenas o estimado**. O realizado vive em `RecommendationOutcome` e é
 * lido por join (B8): duas casas para o mesmo número divergem em silêncio, e a
 * que erra é sempre a projeção. O schema não tem campo para o realizado de
 * propósito — é a forma de tornar a violação impossível, e não só proibida.
 */
export const RECOMMENDATION_IMPACTS_SCHEMA_VERSION = 1;

const impactSchema = z.object({
  /** Os três tipos nunca somam entre si (§9.7). */
  type: z.enum(['SAVINGS', 'EFFICIENCY_GAIN', 'REVENUE_UPLIFT']),
  /** Sempre em moeda-base: é a única unidade comparável entre contas (M1). */
  estimatedBase: z.number(),
  horizonDays: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
});

export const recommendationImpactsSchema = z.object({
  schemaVersion: z.literal(RECOMMENDATION_IMPACTS_SCHEMA_VERSION),
  impacts: z.array(impactSchema).min(1),
});

export type RecommendationImpacts = z.infer<typeof recommendationImpactsSchema>;
