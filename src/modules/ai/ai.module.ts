import { Module } from '@nestjs/common';
import { TextGenerationProviderInterface } from 'src/modules/ai/contracts';
import { StructuredGenerationProviderInterface } from 'src/modules/ai/contracts/structured-generation-provider.contract';
import { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';
import { OpenAIClient } from 'src/modules/ai/infrastructure/clients/openai.client';
import { AnthropicJsonExecutor } from 'src/modules/ai/infrastructure/providers/anthropic/anthropic-json.executor';
import { MemoryAIProvider } from 'src/modules/ai/infrastructure/providers/memory/memory-ai.provider';
import { RoutedStructuredGenerationProvider } from 'src/modules/ai/infrastructure/providers/routing/routed-structured-generation.provider';
import { RoutedTextGenerationProvider } from 'src/modules/ai/infrastructure/providers/routing/routed-text-generation.provider';
import { AIErrorClassifierService } from 'src/modules/ai/infrastructure/routing/ai-error-classifier.service';
import { AIOrchestratorService } from 'src/modules/ai/infrastructure/routing/ai-orchestrator.service';
import { ModelRouterService } from 'src/modules/ai/infrastructure/routing/model-router.service';
import { ProviderHealthRegistry } from 'src/modules/ai/infrastructure/routing/provider-health.registry';
import { AiDecisionLogRepositoryInterface } from './domain/ports/ai-decision-log.repository';
import { AiDecisionLogPrismaRepository } from './infrastructure/database/prisma/ai-decision-log-prisma.repository';
import { AiBudgetReader } from './domain/ports/ai-budget.reader';
import { AiBudgetPrismaReader } from './infrastructure/database/prisma/ai-budget-prisma.reader';

/**
 * IA desacoplada de campanha (A2-S1, entrega 8).
 *
 * Saíram: `ExecuteCampaignAnalysis`, `GenerateAdTitle`, `GenerateAdDescription`
 * e seus prompt-builders, parsers e gateway — todos falavam de uma campanha que
 * a Allva originava, e P1 diz que ela não origina mídia.
 *
 * **Ficou intacto o que tinha valor: o roteamento multi-provider** — classificador
 * de erro por status HTTP, cooldown por `provider:model`, backoff com jitter e
 * health registry (Apêndice C). Ele é agnóstico de assunto, é o ativo mais maduro
 * do módulo, e A2-S4 o religa aos contratos `AdAnalysis*`.
 *
 * O módulo fica **sem consumidor** até lá. Isso é estado declarado, não esquecimento:
 * a alternativa era manter contratos de campanha vivos só para o grafo não ficar
 * vazio — e é assim que domínio ficcional sobrevive a um redesenho.
 */
@Module({
  providers: [
    OpenAIClient,
    AnthropicClient,
    MemoryAIProvider,
    ModelRouterService,
    AIErrorClassifierService,
    ProviderHealthRegistry,
    AIOrchestratorService,
    AnthropicJsonExecutor,
    {
      provide: TextGenerationProviderInterface,
      useClass: RoutedTextGenerationProvider,
    },
    /**
     * **A saída estruturada**, e o segundo contrato de geração do módulo.
     *
     * Dois e não um porque os dois querem coisas opostas do mesmo transporte: o
     * de prosa sanitiza aspas e quebras de linha e corta em fronteira de frase —
     * o que salva a narrativa e destrói um JSON. Reusá-lo para as variantes de
     * copy produziria resposta inválida em toda chamada.
     */
    {
      provide: StructuredGenerationProviderInterface,
      useClass: RoutedStructuredGenerationProvider,
    },
    /**
     * **A contabilidade de custo de IA mora aqui desde A2-S9**, e vinha de
     * `ad-scoring` — onde nasceu por ser o primeiro consumidor, não por ser o
     * dono. `AIDecisionLog` sempre teve `taskType`, `creativeUploadId` e
     * `recommendationId`: o schema declarava três consumidores desde A2-S1.
     *
     * O que forçou a mudança foi o segundo consumidor real (a análise criativa):
     * mantê-la em `ad-scoring` faria `creative-lab` importar o módulo de score
     * para saber quanto pode gastar com LLM — e codificaria "ad-scoring é dono
     * do orçamento de IA", que é falso e confundiria o terceiro.
     */
    {
      provide: AiDecisionLogRepositoryInterface,
      useClass: AiDecisionLogPrismaRepository,
    },
    { provide: AiBudgetReader, useClass: AiBudgetPrismaReader },
  ],
  exports: [
    AIOrchestratorService,
    ModelRouterService,
    TextGenerationProviderInterface,
    StructuredGenerationProviderInterface,
    AiDecisionLogRepositoryInterface,
    AiBudgetReader,
  ],
})
export class AIModule {}
