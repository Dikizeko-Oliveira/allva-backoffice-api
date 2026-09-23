import { z } from 'zod';

/**
 * `CreativeAnalysis.hookSuggestions` / `bodySuggestions` / `ctaSuggestions` /
 * `formatSuggestions` — os quatro campos `Json` de §11.4, passo 5.
 *
 * **As colunas existem desde A2-S1 e nunca foram escritas.** Nasceram declaradas
 * para este passo do pipeline e ficaram esperando produtor; este schema é o
 * contrato que elas passam a cumprir, e a mesma disciplina de
 * `ad-score-components.schema.ts`: mudar a forma vira bump de versão mais
 * migrador de leitura, nunca migração de banco.
 *
 * ## Uma coluna por alvo, e não uma coluna com tudo
 *
 * A separação já estava no schema e é a certa: `REPLACE_COPY` recebe o texto
 * principal e `REPLACE_CTA` recebe a chamada — são ações distintas, com
 * estratégias de mutação distintas por plataforma. Uma coluna única obrigaria
 * quem monta o parâmetro a filtrar por `target` a cada leitura, e é aí que o
 * filtro esquecido manda um texto de corpo para o campo de CTA.
 *
 * ## `withheld` mora em cada coluna, e não numa quinta
 *
 * Ele é a razão pela qual **aquela** lista está vazia. Guardá-lo fora faria a
 * leitura de uma coluna depender de outra, e a primeira leitura parcial perderia
 * a recusa — que é exatamente a informação que a lista vazia não carrega.
 */
export const CREATIVE_SUGGESTIONS_SCHEMA_VERSION = 1;

export const suggestionTargetSchema = z.enum(['HOOK', 'BODY', 'CTA', 'FORMAT']);

export const suggestionTypeSchema = z.enum([
  'WEAK_HOOK',
  'THIN_BODY',
  'MISSING_HEADLINE',
  'MESSAGE_ATTRACTS_WRONG_AUDIENCE',
  'NEGATIVE_FEEDBACK_RISK',
  'MESSAGE_EXHAUSTED',
  'MISSING_CTA',
  'WEAK_CTA',
]);

export const creativeSuggestionSchema = z.object({
  type: suggestionTypeSchema,
  target: suggestionTargetSchema,
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  /** O que foi observado, com o número que sustenta (P7). */
  reason: z.string().min(1),
  /** O que mudar — nunca o texto novo. */
  recommendation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /**
   * `null` nas regras factuais (campo vazio no criativo), que não herdam
   * incerteza de medição nenhuma.
   */
  sourceComponent: z
    .enum([
      'attention',
      'audienceFit',
      'learningStability',
      'negativeFeedbackRisk',
      'fatigue',
    ])
    .nullable(),
});

/** O conteúdo de **uma** das quatro colunas. */
export const suggestionColumnSchema = z.object({
  schemaVersion: z.literal(CREATIVE_SUGGESTIONS_SCHEMA_VERSION),
  items: z.array(creativeSuggestionSchema),
  /**
   * Por que esta lista está vazia, quando a ausência é decisão e não silêncio.
   *
   * O caso vivo é `AUDIENCE_MISMATCH`: a peça funciona nos outros anúncios, e
   * mexer no texto consertaria o que não está quebrado. Sem este campo a tela
   * recebe uma lista vazia e conclui "não há nada a melhorar" — que é o oposto
   * do que a análise concluiu.
   */
  withheld: z.string().nullable(),
});

export type SuggestionColumn = z.infer<typeof suggestionColumnSchema>;
export type PersistedCreativeSuggestion = z.infer<
  typeof creativeSuggestionSchema
>;

/**
 * Lê uma coluna gravada, tolerando o que veio de antes deste schema existir.
 *
 * As quatro colunas são anteriores ao produtor: toda análise gravada até aqui
 * tem `null` nelas. Lançar na leitura faria a tela de uma análise antiga
 * quebrar por causa de um campo que nunca foi preenchido — e o histórico
 * append-only existe justamente para continuar legível.
 */
export function parseSuggestionColumn(value: unknown): SuggestionColumn {
  const parsed = suggestionColumnSchema.safeParse(value);

  if (parsed.success) return parsed.data;

  return {
    schemaVersion: CREATIVE_SUGGESTIONS_SCHEMA_VERSION,
    items: [],
    withheld: null,
  };
}
