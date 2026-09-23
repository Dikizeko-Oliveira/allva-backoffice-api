import { z } from 'zod';

/**
 * `WasteItem.evidence` — campo `Json` normativo (E1, G15).
 *
 * P7 exige evidência mínima declarada: um achado sem os limiares que o
 * dispararam e sem o valor observado não é diagnóstico, é opinião. Este schema
 * é o que impede o detector de gravar "confie em mim".
 */
export const WASTE_EVIDENCE_SCHEMA_VERSION = 1;

export const wasteEvidenceSchema = z.object({
  schemaVersion: z.literal(WASTE_EVIDENCE_SCHEMA_VERSION),
  /** Limiar aplicado e valor observado, lado a lado. */
  thresholds: z.record(z.string(), z.number()),
  observed: z.record(z.string(), z.number()),
  /**
   * Onde o fenômeno foi calculado de fato. Componentes cujo escopo real está
   * acima do anúncio são calculados no escopo real e **imputados** ao anúncio,
   * sempre declarando isto (§3.4).
   */
  scopeLevel: z.enum(['AD', 'AD_SET', 'CAMPAIGN', 'AD_ACCOUNT']),
  /** Os outros anúncios envolvidos quando o escopo é acima do anúncio. */
  relatedAdIds: z.array(z.string()).default([]),
  /** Como o achado do escopo maior foi atribuído a este anúncio (§10.3). */
  attributionRule: z.string().nullable().default(null),
  /** Tamanho da amostra que sustenta o achado. */
  sampleSize: z.number().int().nonnegative().optional(),
  /** Baseline usado — mediana de pares, ou linha de base da conta (D12). */
  benchmark: z
    .object({
      kind: z.enum(['AD_SET_PEERS', 'ACCOUNT_BASELINE']),
      pairs: z.number().int().nonnegative(),
      median: z.number().nullable(),
    })
    .optional(),
});

export type WasteEvidence = z.infer<typeof wasteEvidenceSchema>;
