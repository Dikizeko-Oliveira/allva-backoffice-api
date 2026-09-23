import { Injectable } from '@nestjs/common';
import { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';
import { OpenAIClient } from 'src/modules/ai/infrastructure/clients/openai.client';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { AITaskType, AIProviderType, ModelCandidate } from './ai-task.types';

const DEFAULT_MODELS = {
  openAIAnalysis: 'gpt-5.6-luna',
  openAIFallback: 'gpt-5.4-mini',
  anthropicCopy: 'claude-sonnet-5',
  anthropicFallback: 'claude-haiku-4-5',
} as const;

@Injectable()
export class ModelRouterService {
  constructor(
    private readonly anthropicClient: AnthropicClient,
    private readonly openAIClient: OpenAIClient,
    private readonly env: EnvService,
  ) {}

  /**
   * Ordered route for a task: preferred model first, in-memory fallback last.
   * Providers with no credential are dropped here, so callers never have to
   * know which keys exist.
   */
  getCandidates(task: AITaskType): ModelCandidate[] {
    const openAIAnalysisModel = this.model(
      'OPENAI_CAMPAIGN_ANALYSIS_MODEL',
      DEFAULT_MODELS.openAIAnalysis,
    );
    const openAIFallbackModel = this.model(
      'OPENAI_FALLBACK_MODEL',
      DEFAULT_MODELS.openAIFallback,
    );
    const anthropicCopyModel = this.model(
      'ANTHROPIC_COPY_MODEL',
      DEFAULT_MODELS.anthropicCopy,
    );
    const anthropicFallbackModel = this.model(
      'ANTHROPIC_FALLBACK_MODEL',
      DEFAULT_MODELS.anthropicFallback,
    );

    switch (task) {
      /**
       * **Geração de copy** — a única tarefa que justifica o modelo caro.
       *
       * Aqui o texto vira mídia: sai do produto e entra num anúncio. É a única
       * das quatro em que capacidade extra vira resultado, e não custo por
       * resultado igual. Continua com a Anthropic na frente **e ainda não tem
       * emissor** — `creative_suggestion` é vocabulário sem chamador. A rota
       * fica pronta para quando a geração de copy for construída.
       */
      case 'creative_suggestion':
        return this.configuredOnly([
          { provider: 'anthropic', model: anthropicCopyModel },
          { provider: 'anthropic', model: anthropicFallbackModel },
          { provider: 'openai', model: openAIAnalysisModel },
          { provider: 'memory', model: 'memory-fallback' },
        ]);

      /**
       * **Prosa de laudo, em alto volume** — as três tarefas que rodam de fato.
       *
       * `ad_narrative`, `daily_digest` e `creative_diagnosis` produzem a mesma
       * coisa: 2 a 3 frases factuais, ≤400 caracteres, medidas em 382 tokens de
       * entrada e 186 de saída. O nome `creative_diagnosis` sugere análise
       * estruturada e não é: quem o emite é o narrador do Creative Lab, e o
       * caminho estruturado de verdade (`AnthropicJsonExecutor`) segue sem
       * consumidor.
       *
       * A parte difícil delas **não é raciocínio**: é obediência a restrições —
       * não inventar número, declarar o que não foi medido, terminar a frase —
       * e essas restrições vivem no prompt, no `unavailableReasons` e no corte
       * em fronteira de frase, não na capacidade do modelo.
       *
       * O volume escala com anúncios monitorados: 2.000/dia no teto do plano
       * Profissional. Medido, isso dá R$ 28,86/dia no `claude-sonnet-5` contra
       * R$ 3,30 no `gpt-5.6-luna` — 8,8×. E o teto diário de R$ 25 cortaria em
       * ~1.732 narrativas, **abaixo** dos 2.000 anúncios que o plano vende: o
       * modelo caro tornava o próprio plano internamente inconsistente.
       */
      case 'ad_narrative':
      case 'daily_digest':
      case 'creative_diagnosis':
      default:
        return this.configuredOnly([
          { provider: 'openai', model: openAIAnalysisModel },
          { provider: 'openai', model: openAIFallbackModel },
          /**
           * O terceiro candidato é do **outro fornecedor**, e é o que separa
           * "queda de modelo" de "queda de fornecedor".
           *
           * Uma rota openai→openai→memória entrega texto enlatado a todo mundo
           * durante qualquer incidente da OpenAI. Como a Anthropic só é tocada
           * depois de duas falhas, o perfil de custo continua sendo o do Luna.
           */
          { provider: 'anthropic', model: anthropicCopyModel },
          { provider: 'memory', model: 'memory-fallback' },
        ]);
    }
  }

  /**
   * Drops candidates whose provider has no usable credential.
   *
   * This used to check anthropic only. An unconfigured OpenAI therefore stayed
   * on the route and every request paid for it: the client throws on the missing
   * key, the classifier reads that as `auth`, and the health registry parks a
   * provider that is never coming back for five minutes — once per candidate,
   * on every call, before reaching the fallback. `OpenAIClient.isConfigured()`
   * already existed for this and simply had no caller.
   */
  private configuredOnly(candidates: ModelCandidate[]): ModelCandidate[] {
    return candidates.filter((candidate) =>
      this.isProviderConfigured(candidate.provider),
    );
  }

  private isProviderConfigured(provider: AIProviderType): boolean {
    switch (provider) {
      case 'anthropic':
        return this.anthropicClient.isConfigured();
      case 'openai':
        return this.openAIClient.isConfigured();
      // The in-memory fallback needs no credential; it is what keeps a route
      // from ever being empty.
      case 'memory':
        return true;
    }
  }

  /**
   * Model overrides come through `EnvService` rather than `process.env`, so they
   * are the validated values and a blank override falls back to the default
   * instead of sending an empty model name to the provider.
   */
  private model(
    key:
      | 'OPENAI_CAMPAIGN_ANALYSIS_MODEL'
      | 'OPENAI_FALLBACK_MODEL'
      | 'ANTHROPIC_COPY_MODEL'
      | 'ANTHROPIC_FALLBACK_MODEL',
    fallback: string,
  ): string {
    return this.env.get(key)?.trim() || fallback;
  }
}
