import { Injectable } from '@nestjs/common';
import { AITaskType } from 'src/modules/ai/infrastructure/routing/ai-task.types';

/**
 * Resposta pronta, último candidato de toda rota — para que uma tarefa tenha
 * **forma** mesmo com todos os providers fora do ar. As chaves são lidas
 * estruturalmente por quem chama, daí o record aberto.
 */
export type MemoryAIResult = Record<string, unknown>;

@Injectable()
export class MemoryAIProvider {
  /**
   * **Nenhuma resposta daqui contém número de score.**
   *
   * A redação anterior devolvia `ars: 82`, `attentionScore: 79`,
   * `negativeFeedbackRisk: 29` — números inventados, com a forma exata do que o
   * produto chama de avaliação. Isso inverte P4: o score é **determinístico**, e
   * a IA entra por cima só com texto. Um fallback que fabrica pontuação faz o
   * produto afirmar sobre a mídia do usuário exatamente quando não sabe nada, e
   * a afirmação é indistinguível de uma medição real na tela.
   *
   * O que sobrou é o que um fallback pode honestamente oferecer: texto neutro,
   * que declara a ausência em vez de preenchê-la.
   */
  generate(task: AITaskType): MemoryAIResult {
    switch (task) {
      case 'daily_digest':
      case 'ad_narrative':
        return {
          narrative:
            'Não foi possível gerar a leitura em linguagem natural agora. Os componentes do score e a evidência de cada um continuam disponíveis acima.',
        };

      case 'creative_suggestion':
        return {
          hookSuggestions: [],
          bodySuggestions: [],
          note: 'Sugestões criativas indisponíveis nesta execução.',
        };

      case 'recommendation_title':
        return {
          title: null,
          rationale: null,
          note: 'Título gerado por IA indisponível; a recomendação segue com a descrição determinística.',
        };

      case 'creative_diagnosis':
      default:
        return {
          diagnostics: [],
          alternativeExplanations: [],
          note: 'Diagnóstico criativo indisponível nesta execução.',
        };
    }
  }
}
