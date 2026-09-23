import { Injectable } from '@nestjs/common';
import {
  GeneratedStructured,
  GenerateStructuredInput,
  StructuredGenerationProviderInterface,
} from 'src/modules/ai/contracts/structured-generation-provider.contract';
import { AnthropicJsonExecutor } from 'src/modules/ai/infrastructure/providers/anthropic/anthropic-json.executor';
import { OpenAIClient } from 'src/modules/ai/infrastructure/clients/openai.client';
import { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';
import { AIOrchestratorService } from 'src/modules/ai/infrastructure/routing/ai-orchestrator.service';
import { ModelCandidate } from 'src/modules/ai/infrastructure/routing/ai-task.types';
import { parseJsonResponse } from 'src/modules/ai/infrastructure/utils/json-response.util';

/**
 * A saída estruturada, sobre o mesmo roteamento que a prosa usa desde A2-S4.
 *
 * **`AnthropicJsonExecutor` finalmente tem consumidor.** Ele existia desde
 * A2-S1, `@Injectable`, exportado, e sem ninguém chamando — o próprio arquivo de
 * roteamento registra que "o caminho estruturado de verdade segue sem
 * consumidor". Era a peça esperando a geração de copy.
 *
 * ## O `memory` não entra nesta rota
 *
 * Nas tarefas de prosa, o fallback em memória devolve uma frase que declara a
 * ausência — e isso é honesto porque a frase é claramente uma frase. Aqui, o
 * fallback teria de devolver **texto de anúncio**, e não existe texto de anúncio
 * honesto que uma constante possa produzir: qualquer coisa que ele escrevesse
 * apareceria na tela com a mesma aparência de uma variante gerada, e a pessoa
 * poderia publicá-la sob a marca dela.
 *
 * Recusar aqui é o que faz a promessa da feature valer: sem provider, a resposta
 * é a sugestão determinística **sem variantes**, e nunca uma variante inventada.
 */
@Injectable()
export class RoutedStructuredGenerationProvider extends StructuredGenerationProviderInterface {
  constructor(
    private readonly anthropicJson: AnthropicJsonExecutor,
    private readonly anthropicClient: AnthropicClient,
    private readonly openAIClient: OpenAIClient,
    private readonly orchestrator: AIOrchestratorService,
  ) {
    super();
  }

  async generateJson<T>(
    input: GenerateStructuredInput<T>,
  ): Promise<GeneratedStructured<T>> {
    const routed = await this.orchestrator.run({
      task: input.task,
      /**
       * **Sem `memory`, e sem provider sem credencial.**
       *
       * `canUseCandidate` é o mesmo mecanismo que o roteador usa para pular
       * quem não tem chave; usá-lo para excluir o fallback em memória mantém a
       * decisão num lugar só, em vez de um `filter` paralelo que divergiria da
       * rota de saúde e de cooldown.
       */
      canUseCandidate: (candidate) => this.canUse(candidate),
      execute: async (candidate) => {
        const answer = await this.callProvider(candidate, input);

        /**
         * O parse e a validação acontecem **dentro** do callback.
         *
         * Fora dele, uma resposta malformada contaria como sucesso: o
         * orquestrador marcaria o provider como saudável, devolveria, e a falha
         * apareceria só aqui — com o resto da rota nunca tentado. É o mesmo
         * defeito que a resposta vazia produzia no gerador de prosa, e a
         * correção é a mesma.
         */
        const parsed = input.schema.safeParse(
          parseJsonResponse<unknown>(answer.text),
        );

        if (!parsed.success) {
          throw new Error(
            `Invalid response: ${candidate.provider}/${candidate.model} ` +
              `devolveu JSON fora do contrato — ${parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; ')}`,
          );
        }

        /**
         * O uso viaja junto do valor porque a validação acontece depois da
         * chamada: separá-los perderia os tokens exatamente nas respostas que
         * falharam o contrato — que são as que mais interessam ao custo, porque
         * foram pagas e não produziram nada.
         */
        return {
          value: parsed.data,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        };
      },
    });

    return {
      value: routed.result.value,
      provider: routed.provider,
      model: routed.model,
      inputTokens: routed.result.inputTokens,
      outputTokens: routed.result.outputTokens,
      fallbackUsed: routed.fallbackUsed,
    };
  }

  /**
   * `memory` fora, e provider sem chave fora.
   *
   * A checagem de credencial repete o que o roteador já faz porque ele filtra
   * por variável de ambiente configurada e este contrato precisa do cliente
   * **construível**: os dois clientes resolvem a chave preguiçosamente, e um
   * `UnauthorizedException` no meio da chamada seria classificado como falha do
   * provider em vez de ausência de configuração.
   */
  private canUse(candidate: ModelCandidate): boolean {
    if (candidate.provider === 'memory') return false;
    if (candidate.provider === 'anthropic') {
      return this.anthropicClient.isConfigured();
    }

    return this.openAIClient.isConfigured();
  }

  private async callProvider<T>(
    candidate: ModelCandidate,
    input: GenerateStructuredInput<T>,
  ): Promise<RawAnswer> {
    if (candidate.provider === 'anthropic') {
      return this.anthropicJson.execute({
        model: candidate.model,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        maxTokens: input.maxTokens,
      });
    }

    const completion = await this.openAIClient.client.chat.completions.create({
      model: candidate.model,
      // O modo JSON do provider é a primeira linha de defesa; o schema é a
      // segunda. Confiar só nele deixaria passar um objeto válido com os
      // campos errados, que é a falha que de fato acontece.
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `${input.systemPrompt}\nReturn valid JSON only.`,
        },
        { role: 'user', content: input.userPrompt },
      ],
      max_completion_tokens: input.maxTokens,
    });

    return {
      text: completion.choices[0]?.message?.content || '',
      inputTokens: completion.usage?.prompt_tokens ?? null,
      outputTokens: completion.usage?.completion_tokens ?? null,
    };
  }
}

type RawAnswer = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
};
