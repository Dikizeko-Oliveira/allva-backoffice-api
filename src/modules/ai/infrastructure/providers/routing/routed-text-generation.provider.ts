import { Injectable } from '@nestjs/common';
import {
  GeneratedText,
  GenerateTextInput,
  TextGenerationProviderInterface,
} from 'src/modules/ai/contracts';
import { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';
import { OpenAIClient } from 'src/modules/ai/infrastructure/clients/openai.client';
import { MemoryAIProvider } from 'src/modules/ai/infrastructure/providers/memory/memory-ai.provider';
import { AIOrchestratorService } from 'src/modules/ai/infrastructure/routing/ai-orchestrator.service';
import { ModelCandidate } from 'src/modules/ai/infrastructure/routing/ai-task.types';

@Injectable()
export class RoutedTextGenerationProvider implements TextGenerationProviderInterface {
  constructor(
    private readonly openAIClient: OpenAIClient,
    private readonly anthropicClient: AnthropicClient,
    private readonly memoryAIProvider: MemoryAIProvider,
    private readonly orchestrator: AIOrchestratorService,
  ) {}

  async generateText(input: GenerateTextInput): Promise<GeneratedText> {
    /**
     * Sanitising *inside* the callback is load-bearing.
     *
     * It used to happen after `orchestrator.run` returned. A provider answering
     * with empty content — content filter, token ceiling, a refusal — counted as
     * a success, so the orchestrator recorded a healthy provider and returned;
     * the emptiness only surfaced here, as a 503, with the rest of the route
     * (including the memory fallback, which cannot come back empty) never tried.
     * Throwing here instead makes an empty answer a normal failure the
     * orchestrator can fall through: `invalid_response` is not retryable on the
     * same model but is fallbackable to the next one.
     */
    const routed = await this.orchestrator.run({
      task: input.task,
      execute: async (candidate) => {
        const answer = await this.callProvider(candidate, input);
        const sanitized = this.sanitizeSingleLineText(
          answer.text,
          input.maxCharacters,
        );

        if (!sanitized) {
          throw new Error(
            `Invalid response: ${candidate.provider}/${candidate.model} returned empty ad copy`,
          );
        }

        return { ...answer, text: sanitized };
      },
    });

    // Quem atendeu sai de `routed`, não do que a implementação acha que tentou:
    // é o candidato que de fato venceu, depois de eventuais quedas na rota.
    return {
      text: routed.result.text,
      provider: routed.provider,
      model: routed.model,
      inputTokens: routed.result.inputTokens,
      outputTokens: routed.result.outputTokens,
      fallbackUsed: routed.fallbackUsed,
    };
  }

  /**
   * **Amostragem: nenhum dos dois provedores aceita mais ajuste, e isto é o
   * registro de que foi tentado.**
   *
   * O caminho OpenAI mandava `temperature: 0.9` e o da Anthropic não mandava
   * nada, então trocar de provedor trocava junto o regime de amostragem. A
   * intenção era igualar os dois em 0.2 — a variedade entre narrativas vem do
   * dado, não da amostragem, e variância aqui só compra risco na propriedade que
   * os prompts existem para proteger (P7, não afirmar sobre o que não foi medido).
   *
   * Os dois recusaram, cada um do seu jeito, e cada recusa é um 400 que derruba a
   * chamada inteira — 220 narrativas zeradas por tentativa:
   *
   * - `claude-sonnet-5`: `temperature is deprecated for this model`
   * - `gpt-5.6-luna`: `does not support 0.2 with this model. Only the default (1)`
   *
   * Ou seja: nesta geração de modelos a temperatura deixou de ser alavanca. A
   * disciplina factual continua vindo de onde já vinha e onde é verificável — o
   * prompt que proíbe inventar número, o `unavailableReasons` que declara a
   * ausência, o corte em fronteira de frase. Nada é enviado, os dois usam o
   * default, e a simetria que se queria acabou vindo de graça.
   *
   * Se um modelo futuro voltar a aceitar o parâmetro, o lugar de decidir é aqui —
   * e a decisão de então continua sendo 0.2, pelo motivo acima.
   */
  private async callProvider(
    candidate: ModelCandidate,
    input: GenerateTextInput,
  ): Promise<{
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }> {
    if (candidate.provider === 'memory') {
      // Não é LLM: zero tokens é a medida certa, não uma medição ausente.
      return {
        text: this.generateMemoryFallback(input.task),
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    if (candidate.provider === 'anthropic') {
      const response = await this.anthropicClient.createMessage({
        model: candidate.model,
        system: input.systemPrompt,
        prompt: input.userPrompt,
        maxTokens: maxTokensFor(input.maxCharacters),
      });

      // `?? null` na fronteira: uso ausente é `null` ("não medido"), nunca
      // `undefined` vazando para quem grava o log.
      return {
        text: response.text,
        inputTokens: response.inputTokens ?? null,
        outputTokens: response.outputTokens ?? null,
      };
    }

    const completion = await this.openAIClient.client.chat.completions.create({
      model: candidate.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      max_completion_tokens: maxTokensFor(input.maxCharacters),
    });

    return {
      text: completion.choices[0]?.message?.content || '',
      inputTokens: completion.usage?.prompt_tokens ?? null,
      outputTokens: completion.usage?.completion_tokens ?? null,
    };
  }

  private sanitizeSingleLineText(value: string, maxCharacters: number): string {
    const sanitized = value
      .replace(/["'`]/g, '')
      .replace(/^(Titulo|Título|Descricao|Descrição)\s*:\s*/i, '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!sanitized) {
      return '';
    }

    return trimToBoundary(sanitized, maxCharacters);
  }

  private generateMemoryFallback(task: GenerateTextInput['task']): string {
    const generated = this.memoryAIProvider.generate(task);

    // A resposta pronta guarda o texto sob o campo que a tarefa produz. A lista
    // acompanha os assuntos ads-first de A2-S4: `narrative` para a leitura do
    // score, `note` para as tarefas cujo fallback é declarar a ausência em vez
    // de preenchê-la — porque um fallback que inventa conteúdo é pior que um que
    // admite não ter.
    for (const key of ['text', 'narrative', 'title', 'note', 'description']) {
      const value = generated[key];

      if (typeof value === 'string') {
        return value;
      }
    }

    return '';
  }
}

/**
 * Corta no fim de uma frase — nunca no meio de uma palavra.
 *
 * `slice(maxCharacters)` cru parecia inofensivo e não era: o prompt pede três
 * frases sem dizer o orçamento, o modelo escreve três frases de 450 caracteres,
 * e o produto exibia 400 deles. Numa amostra de 220 narrativas de score, 201
 * bateram exatamente no teto e só 23 terminavam em pontuação — ou seja, nove em
 * cada dez usuários liam uma frase interrompida no meio de uma palavra. O texto
 * estava correto; o que parecia quebrado era o produto.
 *
 * A ordem das tentativas é a ordem da qualidade do resultado:
 *
 * 1. **Fim de frase** dentro do orçamento — o corte fica invisível, que é o
 *    melhor desfecho possível.
 * 2. **Fronteira de palavra** com reticências — declara que há mais texto em vez
 *    de fingir que a frase acabou ali.
 *
 * O piso de 60% existe para o caso 1 não piorar o texto: uma primeira frase
 * curta ("O anúncio foi bem.") satisfaria "termina em pontuação" e jogaria fora
 * dois terços do que o modelo explicou. Abaixo do piso, o caso 2 entrega mais
 * informação — mesmo com o corte visível.
 */
const MIN_SENTENCE_RATIO = 0.6;

export function trimToBoundary(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;

  const window = text.slice(0, maxCharacters);

  // Pontuação seguida de espaço ou de fim de janela: um ponto no meio de
  // "R$ 1.234" não termina frase, e cortar ali partiria o número.
  let lastSentenceEnd = -1;
  const sentenceEnd = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(window)) !== null) {
    lastSentenceEnd = match.index;
  }

  if (lastSentenceEnd >= Math.floor(maxCharacters * MIN_SENTENCE_RATIO)) {
    return window.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) {
    // A reticência entra **dentro** do orçamento, não além dele: quem pediu 400
    // caracteres tem um limite de tela, não uma preferência.
    return `${window.slice(0, lastSpace).trim()}…`;
  }

  return window.trim();
}

/**
 * O teto de tokens **derivado** do orçamento de caracteres, e não um número solto.
 *
 * Era `300` fixo, e 300 tokens não cobrem 400 caracteres de português com folga:
 * texto acentuado tokeniza mal, e o modelo parava no meio da frase **antes** de
 * qualquer corte nosso acontecer. O sintoma enganava — parecia truncamento de
 * transporte, mas 13 de 220 narrativas chegavam interrompidas com 153 a 359
 * caracteres, todas abaixo do teto de 400, ou seja cortadas na origem.
 *
 * A folga é deliberadamente exagerada — **duas vezes** o orçamento em
 * caracteres. Um token por caractere já é o pior caso teórico de tokenização, e
 * mesmo assim o teto encostou em 2 de 220 narrativas de 330 e 377 caracteres: a
 * margem tem de ser larga o bastante para nunca ser ela a decidir onde o texto
 * acaba. E ela é grátis, porque `max_tokens` é limite e não consumo — o
 * provider cobra o que gerou, não o que foi autorizado a gerar.
 *
 * Quem limita o tamanho é o prompt, que declara o orçamento, e o corte em
 * fronteira de frase, para quando o modelo passa um pouco. `max_tokens` não é
 * lugar de controlar tamanho: ali ele só decide se a última frase termina.
 */
function maxTokensFor(maxCharacters: number): number {
  return Math.max(512, maxCharacters * 2);
}
