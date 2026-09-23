import {
  AIProviderType,
  AITaskType,
} from 'src/modules/ai/infrastructure/routing/ai-task.types';

export type GenerateTextInput = {
  task: AITaskType;
  systemPrompt: string;
  userPrompt: string;
  maxCharacters: number;
};

/**
 * O que a geração devolve — texto **e** procedência.
 *
 * Devolvia `Promise<string>`, e o buraco não era teórico: os três narradores
 * gravavam `provider: 'routed'`, `model: 'unknown'` e custo zero em
 * `AIDecisionLog`, então 881 chamadas não sabiam responder nem quem atendeu nem
 * quanto custaram. Duas consequências caras: o teto diário de LLM comparava
 * sempre zero contra o limite e nunca podia cortar, e verificar qual provedor
 * está servindo exigia abrir o console do fornecedor.
 *
 * O orquestrador **já sabia** de tudo isso — `run` devolve `{ result, provider,
 * model }` desde sempre, e a implementação descartava dois dos três campos.
 *
 * Tokens são anuláveis: nem toda resposta traz uso (o fallback em memória não
 * chama LLM nenhum). `null` é "não medido", e é diferente de zero.
 */
export type GeneratedText = {
  text: string;
  provider: AIProviderType;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** O vencedor não era o primeiro da rota. */
  fallbackUsed: boolean;
};

export abstract class TextGenerationProviderInterface {
  abstract generateText(input: GenerateTextInput): Promise<GeneratedText>;
}
