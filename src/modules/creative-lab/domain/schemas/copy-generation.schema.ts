import { z } from 'zod';
import { creativeSuggestionSchema } from './creative-suggestions.schema';

/**
 * `CopyGeneration.context` e `CopyVariant.reasoning` — os dois campos `Json` da
 * geração de copy (E1, G15).
 *
 * ## Por que `context` é snapshot versionado e não blob
 *
 * A razão de salvar toda geração é responder, meses depois, **qual sugestão de
 * fato melhorou o desempenho**. Um blob de texto livre responde "alguma coisa
 * que a IA leu"; um snapshot com os identificadores responde a pergunta.
 *
 * É P7 aplicado a uma superfície onde ele ainda não incidia: o texto que foi ao
 * ar precisa ser reconduzível ao score, à análise e à sugestão que o pediram —
 * inclusive depois de o score ter mudado e a análise ter ganhado versões novas.
 */
export const COPY_GENERATION_CONTEXT_SCHEMA_VERSION = 1;

const componentReadingSchema = z.object({
  normalizedValue: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  available: z.boolean(),
});

/**
 * O que o usuário escolheu — as **únicas** três perguntas do formulário.
 *
 * Tudo o mais é preenchido pela plataforma. Perguntar ao usuário o que a Allva
 * já sabe é o que transforma a feature num formulário de gerador genérico, que é
 * exatamente o que ela não é.
 */
export const copyGenerationInputsSchema = z.object({
  objective: z.enum(['CONVERSION', 'LEADS', 'TRAFFIC', 'AWARENESS']),
  tone: z.enum([
    'PROFESSIONAL',
    'DIRECT',
    'PERSUASIVE',
    'CASUAL',
    'EDUCATIONAL',
  ]),
  focus: z.enum([
    'BENEFIT',
    'PAIN',
    'OFFER',
    'SOCIAL_PROOF',
    'URGENCY',
    'DIFFERENTIATION',
  ]),
  /** O único campo livre. Opcional por desenho. */
  extraInstructions: z.string().max(500).nullable(),
});

export type CopyGenerationInputs = z.infer<typeof copyGenerationInputsSchema>;

export const copyGenerationContextSchema = z.object({
  schemaVersion: z.literal(COPY_GENERATION_CONTEXT_SCHEMA_VERSION),

  ad: z.object({
    id: z.string(),
    name: z.string(),
    platform: z.string(),
    /** O objetivo declarado na plataforma — não o que o usuário escolheu. */
    campaignObjective: z.string().nullable(),
    /** Proxy de público: é o que a plataforma expõe sem tocar em segmentação. */
    optimizationGoal: z.string().nullable(),
  }),

  /**
   * **A copy no instante do pedido.**
   *
   * Guardada mesmo em `FROM_BRIEF`, que a ignora ao gerar: sem ela, o "antes e
   * depois" que justifica a variação some do histórico assim que a plataforma
   * sincronizar um texto novo.
   */
  currentCopy: z.object({
    headline: z.string().nullable(),
    body: z.string().nullable(),
    callToAction: z.string().nullable(),
    landingPageUrl: z.string().nullable(),
  }),

  score: z
    .object({
      adScoreId: z.string(),
      aiScore: z.number(),
      aiConfidence: z.number(),
      components: z.record(z.string(), componentReadingSchema),
    })
    .nullable(),

  analysis: z
    .object({
      id: z.string(),
      version: z.number(),
      /** `null` abaixo de três anúncios comparáveis (§11.3). */
      verdict: z.string().nullable(),
    })
    .nullable(),

  /**
   * As sugestões que originaram o pedido, **copiadas** e não referenciadas.
   *
   * A análise é append-only e ganha versões novas; uma referência por id leria,
   * meses depois, a sugestão de outra versão — e o `reasoning` da variante
   * passaria a citar uma recomendação que nunca foi feita a ela.
   */
  suggestions: z.array(creativeSuggestionSchema),

  inputs: copyGenerationInputsSchema,
});

export type CopyGenerationContext = z.infer<typeof copyGenerationContextSchema>;

/**
 * `CopyVariant.reasoning` — **"por que a Allva recomenda esta versão"**.
 *
 * Cada afirmação aponta para a sugestão que ela atende, e é esse vínculo que a
 * separa de um texto solto do modelo. Sem `addressesSuggestion`, a explicação
 * seria mais prosa gerada — e a tela estaria exibindo IA para justificar IA.
 */
export const COPY_VARIANT_REASONING_SCHEMA_VERSION = 1;

export const copyVariantReasoningSchema = z.object({
  schemaVersion: z.literal(COPY_VARIANT_REASONING_SCHEMA_VERSION),
  points: z.array(
    z.object({
      claim: z.string().min(1),
      /**
       * `null` quando a afirmação não corresponde a nenhuma sugestão emitida.
       *
       * Permitido de propósito: o modelo pode acertar algo que a regra não
       * detectou. O que não é permitido é **parecer** que a Allva pediu aquilo
       * — e o `null` é o que a tela usa para não creditar à análise o que veio
       * do modelo.
       */
      addressesSuggestion: creativeSuggestionSchema.shape.type.nullable(),
    }),
  ),
});

export type CopyVariantReasoning = z.infer<typeof copyVariantReasoningSchema>;

/**
 * O que o modelo tem de devolver — validado **na fronteira**.
 *
 * Resposta que não casa com este schema é `invalid_response`: não-retentável no
 * mesmo modelo, mas com fallback para o próximo da rota. É o mesmo tratamento
 * que a resposta vazia já recebe em `RoutedTextGenerationProvider`, e pela mesma
 * razão — um parse frouxo aqui gravaria `undefined` como texto de anúncio.
 */
/**
 * **`nullish` e não `nullable` nos campos de texto.**
 *
 * `z.string().nullable()` exige a chave presente, e modelo **omite** o que é
 * nulo — mesmo instruído a não omitir. Recusar a variação inteira por causa de
 * uma chave ausente descartaria uma resposta paga e correta em tudo o que
 * importa; o `?? null` que o `transform` aplica normaliza a diferença num lugar
 * só, e quem lê depois vê sempre a mesma forma.
 *
 * O que **não** afrouxa é `angle`: sem ele a variação não é um ângulo, e o
 * ângulo é a feature. Uma resposta sem ele é resposta errada, não incompleta.
 */
const nullableText = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

export const generatedVariantSchema = z.object({
  angle: z.enum(['BENEFIT', 'PAIN', 'OUTCOME', 'PROOF', 'URGENCY']),
  hook: nullableText,
  primaryText: nullableText,
  headline: nullableText,
  description: nullableText,
  callToAction: nullableText,
  reasoning: z
    .array(
      z.object({
        claim: z.string().min(1),
        addressesSuggestion: z
          .string()
          .nullish()
          .transform((value) => value ?? null),
      }),
    )
    .nullish()
    .transform((value) => value ?? []),
});

/**
 * O envelope aceita **as duas formas que os modelos de fato devolvem**.
 *
 * A pedida é `{ variants: [...] }`, e é a que o prompt declara. A lista nua no
 * topo é o desvio comum quando a instrução pede "três variações" — e recusá-la
 * gastaria uma chamada do modelo mais caro do catálogo para reaprender a mesma
 * lição. Normalizar aqui é uma linha; a alternativa é uma rota que só sabe
 * falhar quando o modelo acerta o conteúdo e erra o invólucro.
 */
export const generatedCopySchema = z.preprocess(
  (value) => (Array.isArray(value) ? { variants: value } : value),
  z.object({ variants: z.array(generatedVariantSchema).min(1) }),
);

export type GeneratedVariant = z.infer<typeof generatedVariantSchema>;
