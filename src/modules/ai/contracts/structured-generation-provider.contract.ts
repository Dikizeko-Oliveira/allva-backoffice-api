import type { ZodType } from 'zod';
import type {
  AIProviderType,
  AITaskType,
} from 'src/modules/ai/infrastructure/routing/ai-task.types';

/**
 * Geração com **saída estruturada**, sobre o mesmo roteamento multi-provider.
 *
 * ## Por que não reusar `TextGenerationProviderInterface`
 *
 * Ele não é genérico: é um gerador de **prosa curta**, e o sanitizador dele faz
 * exatamente o que quebraria um JSON — `replace(/["'`]/g, '')` remove as aspas,
 * `replace(/\r?\n+/g, ' ')` junta as linhas, e `trimToBoundary` corta no fim da
 * última frase que couber no orçamento de caracteres. Passar três variantes
 * estruturadas por ali produziria JSON inválido em toda chamada.
 *
 * Isso não é defeito do outro contrato: aquele comportamento existe porque as
 * narrativas chegavam cortadas no meio da palavra em nove de cada dez casos. Os
 * dois contratos querem coisas opostas do mesmo transporte, e é por isso que são
 * dois.
 *
 * ## O schema entra na fronteira, e é o que torna a rota útil
 *
 * `AIOrchestratorService` já sabe cair para o próximo candidato quando o atual
 * falha. Validar aqui dentro — e **lançar** quando não valida — é o que faz uma
 * resposta malformada virar uma falha que a rota contorna, em vez de um objeto
 * meio preenchido que segue adiante e vira texto de anúncio com `undefined`.
 *
 * É o mesmo precedente da resposta vazia, que virou exceção dentro do callback
 * do orquestrador pela mesma razão: fora dele, o provider era marcado como
 * saudável e o resto da rota nunca era tentado.
 */
export type GenerateStructuredInput<T> = {
  task: AITaskType;
  systemPrompt: string;
  userPrompt: string;
  /** O contrato da resposta. Não casou, não passa. */
  schema: ZodType<T>;
  /**
   * Teto de tokens da resposta.
   *
   * Em tokens e não em caracteres, ao contrário do contrato de prosa: aqui não
   * há corte em fronteira de frase possível — JSON truncado é JSON inválido, e
   * o remédio é caber, não aparar.
   */
  maxTokens: number;
};

export type GeneratedStructured<T> = {
  value: T;
  provider: AIProviderType;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** O vencedor não era o primeiro da rota. */
  fallbackUsed: boolean;
};

export abstract class StructuredGenerationProviderInterface {
  abstract generateJson<T>(
    input: GenerateStructuredInput<T>,
  ): Promise<GeneratedStructured<T>>;
}
