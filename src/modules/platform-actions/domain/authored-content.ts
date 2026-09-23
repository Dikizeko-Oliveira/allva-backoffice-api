import type { ActionParameterType } from 'src/modules/ads/domain/actions/action-parameters.schema';

/**
 * R14 / entrega 14 — **conteúdo autoral de IA exige confirmação explícita.**
 *
 * O texto que estas ações escrevem vai ao ar **sob a marca do cliente**. Um
 * modelo pode produzir uma afirmação que a empresa não pode fazer — promessa de
 * resultado, comparação com concorrente, alegação regulada — e o dano não é um
 * anúncio ruim: é a empresa tendo dito aquilo publicamente.
 *
 * Por isso três regras, e nenhuma delas é sobre qualidade do texto:
 *
 * 1. **`aiAuthored` declarado.** O schema já o exige; aqui se verifica que ele
 *    foi decidido, não herdado de um default.
 * 2. **Confirmação do texto final**, não do pedido. O usuário confirma o que
 *    vai ao ar — se o texto mudou depois da confirmação, ela não vale mais.
 * 3. **Nunca em lote.** Confirmar cem textos num clique é não confirmar nenhum,
 *    e é exatamente o que um lote de cem itens produz.
 *
 * A guarda nasce **antes** das ações que a exigem: `REPLACE_COPY` e
 * `REPLACE_CTA` entram na segunda metade do sprint, e o gateway as declara
 * indisponíveis hoje. Escrevê-la depois significaria ligá-las primeiro e
 * proteger em seguida — a ordem em que o produto publica texto de LLM sem
 * ninguém ter lido.
 */

/** As ações cujos parâmetros carregam texto que vai ao ar. */
export const AUTHORED_CONTENT_ACTIONS: readonly ActionParameterType[] = [
  'REPLACE_COPY',
  'REPLACE_CTA',
];

export function carriesAuthoredContent(type: ActionParameterType): boolean {
  return AUTHORED_CONTENT_ACTIONS.includes(type);
}

export type AuthorshipFailure = {
  code: string;
  message: string;
  remediation: string;
};

export type AuthorshipInput = {
  actionType: ActionParameterType;
  /** `aiAuthored` dos parâmetros já validados pelo schema. */
  aiAuthored: boolean | undefined;
  /** O texto que vai ao ar. */
  content: string | undefined;
  /**
   * O dígito do texto que o usuário confirmou. Comparado com o do conteúdo:
   * confirmar o pedido não é confirmar o texto, e entre um e outro cabe uma
   * regeneração.
   */
  confirmedContentDigest: string | undefined;
  /** Quantos itens o pedido carrega. Acima de um, não há confirmação possível. */
  batchSize: number;
  digestOf: (content: string) => string;
};

export function checkAuthoredContent(
  input: AuthorshipInput,
): AuthorshipFailure | null {
  if (!carriesAuthoredContent(input.actionType)) return null;

  if (input.batchSize > 1) {
    return {
      code: 'AI_CONTENT_NOT_ALLOWED_IN_BATCH',
      message:
        'Conteúdo autoral não pode ser aplicado em lote: cada texto é confirmado individualmente.',
      remediation: 'Envie uma ação por anúncio, com o texto confirmado.',
    };
  }

  if (input.aiAuthored === undefined) {
    return {
      code: 'AI_AUTHORSHIP_NOT_DECLARED',
      message: 'A ação não declara se o texto foi gerado por IA.',
      remediation: 'Informe `aiAuthored` nos parâmetros da ação.',
    };
  }

  /**
   * Texto humano não precisa de confirmação separada: quem o escreveu já o leu.
   * A exigência existe porque ninguém lê o que não escreveu.
   */
  if (!input.aiAuthored) return null;

  if (!input.content) {
    return {
      code: 'AI_CONTENT_MISSING',
      message: 'A ação declara conteúdo de IA mas não traz o texto.',
      remediation: 'Envie o texto final nos parâmetros da ação.',
    };
  }

  if (!input.confirmedContentDigest) {
    return {
      code: 'AI_CONTENT_CONFIRMATION_REQUIRED',
      message:
        'Texto gerado por IA exige confirmação explícita do conteúdo final.',
      remediation:
        'Reenvie com `confirmedContentDigest` correspondente ao texto que vai ao ar.',
    };
  }

  if (input.confirmedContentDigest !== input.digestOf(input.content)) {
    return {
      code: 'AI_CONTENT_CHANGED_AFTER_CONFIRMATION',
      message:
        'O texto mudou depois da confirmação: o que seria publicado não é o que foi aprovado.',
      remediation: 'Revise o texto atual e confirme de novo.',
    };
  }

  return null;
}

/**
 * De onde sai o texto e a declaração de autoria nos parâmetros.
 *
 * `REPLACE_COPY` guarda em `primaryText` — ou, no Google, em
 * `assetReplacement.value` — e `REPLACE_CTA` em `callToAction`. O chamador não
 * deveria precisar saber disso: é detalhe do schema por tipo, e espalhá-lo pelo
 * use case criaria um segundo lugar para esquecer um campo novo. Foi exatamente
 * o que o alvo de asset teria sido sem esta função: um texto de IA indo ao ar
 * sem passar pela confirmação.
 */
export function authorshipOf(parameters: Record<string, unknown>): {
  aiAuthored: boolean | undefined;
  content: string | undefined;
} {
  const asset = parameters.assetReplacement as { value?: unknown } | undefined;
  const text =
    parameters.primaryText ?? asset?.value ?? parameters.callToAction;

  return {
    aiAuthored:
      typeof parameters.aiAuthored === 'boolean'
        ? parameters.aiAuthored
        : undefined,
    content: typeof text === 'string' ? text : undefined,
  };
}
