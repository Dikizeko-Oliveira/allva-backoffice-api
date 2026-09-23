import { z } from 'zod';

/**
 * `AdAction.parameters` — campo `Json` normativo (E1, G15).
 *
 * **Um schema por tipo de ação**, e é essa granularidade que importa: um schema
 * genérico aceitaria `ADJUST_AD_SET_BUDGET` sem `dailyBudget` e o erro apareceria
 * na plataforma, movendo — ou não movendo — dinheiro real.
 *
 * **Valores monetários sempre na moeda da conta** (M3). Enviar a moeda-base
 * moveria dinheiro real na quantia errada em toda conta que não fatura nela, e o
 * erro seria silencioso: a API aceita o número, só que ele significa outra coisa.
 *
 * ---
 *
 * **Mora em `ads` porque tem dois lados.** Nasceu em `recommendations`, que é
 * quem planeja, e A2-S7 trouxe quem executa — e os dois precisam da mesma
 * definição. `recommendations` não pode importar `platform-actions` (§5.3 r.5,
 * verificado pelo harness), e `platform-actions` não deve importar
 * `recommendations`: uma ação `USER_DIRECT` não tem recomendação nenhuma por
 * trás, e fazer o executor depender de um produtor específico inverteria a
 * relação. `ads` é a base do grafo, que ambos já importam, e é onde
 * `AdActionType` já vive.
 *
 * O sprint encontrou **dois** schemas para esta coluna — este, em uso, e um
 * segundo em `platform-actions` declarado "normativo" e nunca chamado. O
 * segundo foi apagado: duas definições da mesma coluna divergem, e a que erra é
 * sempre a que ninguém exercita.
 */
export const ACTION_PARAMETERS_SCHEMA_VERSION = 1;

/**
 * Todo parâmetro persistido carrega a **própria versão de contrato**.
 *
 * Não é cerimônia: `REPLACE_COPY` ganha campos em A2-S7 (confirmação de texto
 * autoral) e A2-S8 (`validationDepth`), e uma ação gravada hoje precisa
 * continuar legível depois. Sem a versão dentro do `Json`, a única saída seria
 * inferir a forma pela data — que é adivinhar.
 */
const versioned = z.object({
  schemaVersion: z.literal(ACTION_PARAMETERS_SCHEMA_VERSION),
});

const adTarget = versioned.extend({ adId: z.string().min(1) });

const budgetChange = versioned.extend({
  dailyBudget: z.number().positive(),
  /** O valor de antes, para a reversão de §9.6 derivar o parâmetro dela. */
  previousDailyBudget: z.number().positive(),
  /** ISO-4217 da **conta**, nunca a moeda-base (M3). */
  currency: z.string().length(3),
});

export const ACTION_PARAMETER_SCHEMAS = {
  PAUSE_AD: adTarget,
  ENABLE_AD: adTarget,
  ARCHIVE_AD: adTarget,
  DUPLICATE_AD: adTarget,
  REPLACE_CREATIVE: adTarget.extend({ creativeId: z.string().min(1) }),
  /**
   * R14: conteúdo autoral de IA exige `aiAuthored` declarado e confirmação
   * explícita do texto final. O campo nasce obrigatório aqui para que a ação não
   * possa ser criada sem a declaração — mesmo antes de A2-S7 executá-la.
   *
   * **Duas formas, e exatamente uma por ação.** Meta e TikTok têm um texto
   * principal: `primaryText`. O anúncio de busca do Google não tem — tem listas
   * de títulos e descrições, e o Google combina esses assets na veiculação.
   * Ali a troca é **de um asset escolhido pela pessoa** (`assetReplacement`),
   * nunca da lista inteira nem um acréscimo: substituir tudo apagaria o que está
   * funcionando, e acrescentar não é trocar.
   *
   * A adição é compatível com a versão 1: toda ação já gravada traz
   * `primaryText` e continua válida.
   */
  REPLACE_COPY: adTarget
    .extend({
      primaryText: z.string().min(1).optional(),
      assetReplacement: z
        .object({
          field: z.enum(['HEADLINE', 'DESCRIPTION']),
          /** Posição do asset na lista do anúncio, como a plataforma a devolve. */
          index: z.number().int().min(0),
          /**
           * O texto que a pessoa viu naquela posição. A escrita confere antes de
           * gravar: se o asset mudou desde então, a troca é recusada em vez de
           * sobrescrever um texto que ninguém escolheu substituir.
           */
          currentValue: z.string().min(1),
          value: z.string().min(1),
        })
        .optional(),
      aiAuthored: z.boolean(),
    })
    .refine(
      (parameters) =>
        (parameters.primaryText === undefined) !==
        (parameters.assetReplacement === undefined),
      {
        message:
          'REPLACE_COPY leva exatamente um alvo: `primaryText` ou `assetReplacement`.',
      },
    ),
  REPLACE_CTA: adTarget.extend({
    callToAction: z.string().min(1),
    aiAuthored: z.boolean(),
  }),
  PAUSE_AD_SET: versioned.extend({ adSetId: z.string().min(1) }),
  ENABLE_AD_SET: versioned.extend({ adSetId: z.string().min(1) }),
  ADJUST_AD_SET_BUDGET: budgetChange.extend({ adSetId: z.string().min(1) }),
  PAUSE_CAMPAIGN: versioned.extend({ campaignId: z.string().min(1) }),
  ENABLE_CAMPAIGN: versioned.extend({ campaignId: z.string().min(1) }),
  ADJUST_CAMPAIGN_BUDGET: budgetChange.extend({
    campaignId: z.string().min(1),
  }),
} as const;

export type ActionParameterType = keyof typeof ACTION_PARAMETER_SCHEMAS;

/**
 * Os parâmetros de um tipo específico — o que o executor recebe já validado.
 *
 * `parseActionParameters` devolve `Record<string, unknown>` porque o tipo só é
 * conhecido em runtime na hora de gravar. Quem **executa** já sabe o tipo, e aí
 * o `Record` seria uma perda: cada leitura de `dailyBudget` viraria um cast, e o
 * cast é onde um campo renomeado passa como `undefined` até a plataforma
 * responder.
 */
export type ActionParametersOf<T extends ActionParameterType> = z.infer<
  (typeof ACTION_PARAMETER_SCHEMAS)[T]
>;

/** Qualquer forma válida da coluna, para quem ainda não estreitou o tipo. */
export type AdActionParameters = {
  [T in ActionParameterType]: ActionParametersOf<T>;
}[ActionParameterType];

/**
 * As ações cujos parâmetros carregam orçamento — as únicas que movem dinheiro
 * por valor, e não por estado.
 */
export const BUDGET_ACTION_TYPES = [
  'ADJUST_AD_SET_BUDGET',
  'ADJUST_CAMPAIGN_BUDGET',
] as const satisfies readonly ActionParameterType[];

export function isBudgetAction(
  type: ActionParameterType,
): type is (typeof BUDGET_ACTION_TYPES)[number] {
  return (BUDGET_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * Valida os parâmetros contra o schema **do tipo**.
 *
 * Lança quando não casa. A alternativa — devolver `false` e deixar o chamador
 * decidir — é como uma ação malformada chega ao banco: alguém esquece de olhar
 * o retorno, e a linha grava.
 */
export function parseActionParameters(
  type: ActionParameterType,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const schema = ACTION_PARAMETER_SCHEMAS[type];

  if (!schema) {
    throw new Error(`Nenhum schema de parâmetros declarado para ${type}`);
  }

  // A versão é carimbada aqui, e não pelo chamador: um planejador que a
  // esquecesse gravaria parâmetros indistinguíveis dos de uma versão futura.
  return schema.parse({
    schemaVersion: ACTION_PARAMETERS_SCHEMA_VERSION,
    ...parameters,
  }) as Record<string, unknown>;
}
