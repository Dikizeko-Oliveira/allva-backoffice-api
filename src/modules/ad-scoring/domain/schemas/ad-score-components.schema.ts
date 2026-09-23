import { z } from 'zod';

/**
 * `AdScore.components` — um dos cinco campos `Json` normativos (E1, G15).
 *
 * **Por que schema versionado e não `Json` livre.** A migração de A2-S1 congela
 * em duas semanas um schema cujas decisões só são tomadas em S4–S7. Isso só é
 * aceitável se a forma de cada `Json` for validada por schema versionado desde
 * já: mudar a estrutura vira bump de versão mais migrador de leitura, não
 * migração de banco. Sem essa disciplina, "o schema nasce correto" seria uma
 * aposta sobre decisões que ainda não foram tomadas.
 */
export const AD_SCORE_COMPONENTS_SCHEMA_VERSION = 1;

/**
 * Cada componente carrega as duas escalas de propósito (§12.2):
 * `value` na escala nativa, consumida pelos detectores, e `normalizedValue`
 * em 0..100 crescente, consumida pelo composto. Guardar só a normalizada
 * perderia o número que o usuário reconhece; guardar só a nativa obrigaria o
 * composto a normalizar de novo a cada leitura, com outra versão de algoritmo.
 */
export const adScoreComponentSchema = z.object({
  value: z.number().nullable(),
  normalizedValue: z.number().min(0).max(100).nullable(),
  /** `false` quando a plataforma não expõe o sinal (PlatformProfile). */
  available: z.boolean(),
  confidence: z.number().min(0).max(1),
  /** Por que está indisponível, ou por que a confiança caiu (P7). */
  reasons: z.array(z.string()).default([]),
});

export const adScoreComponentsSchema = z.object({
  schemaVersion: z.literal(AD_SCORE_COMPONENTS_SCHEMA_VERSION),
  attention: adScoreComponentSchema,
  audienceFit: adScoreComponentSchema,
  negativeFeedbackRisk: adScoreComponentSchema,
  learningStability: adScoreComponentSchema,
  fatigue: adScoreComponentSchema,
});

export type AdScoreComponents = z.infer<typeof adScoreComponentsSchema>;
export type AdScoreComponent = z.infer<typeof adScoreComponentSchema>;
