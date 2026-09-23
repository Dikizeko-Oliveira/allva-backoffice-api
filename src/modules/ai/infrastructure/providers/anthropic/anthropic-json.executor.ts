import { Injectable } from '@nestjs/common';
import { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';

/**
 * O caminho de **saída estruturada** da Anthropic.
 *
 * Existia desde A2-S1 sem nenhum chamador — o arquivo de roteamento registra
 * isso em nota: *"o caminho estruturado de verdade segue sem consumidor"*. A
 * geração de copy é o consumidor que ele esperava.
 *
 * **Passou a devolver o uso junto do texto.** Devolvia `Promise<string>`, que é
 * o mesmo buraco que `TextGenerationProviderInterface` teve de fechar: sem
 * tokens, toda chamada estruturada gravaria custo zero em `AIDecisionLog`, o
 * teto diário compararia sempre zero contra o limite e nunca poderia cortar — e
 * esta é a tarefa que roteia para o modelo mais caro do catálogo.
 */
@Injectable()
export class AnthropicJsonExecutor {
  constructor(private readonly anthropicClient: AnthropicClient) {}

  async execute(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    /**
     * Teto da resposta, em tokens.
     *
     * Opcional para não quebrar quem chamava sem ele — mas a geração de copy
     * sempre passa: JSON truncado é JSON inválido, e aqui não existe o corte em
     * fronteira de frase que salva a prosa.
     */
    maxTokens?: number;
  }): Promise<{
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }> {
    const response = await this.anthropicClient.createMessage({
      model: input.model,
      system: `${input.systemPrompt}\nReturn valid JSON only.`,
      prompt: input.userPrompt,
      maxTokens: input.maxTokens,
    });

    return {
      text: response.text,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }
}
