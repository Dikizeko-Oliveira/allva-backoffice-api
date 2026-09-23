import { z } from 'zod';
import { RoutedStructuredGenerationProvider } from './routed-structured-generation.provider';
import { AIOrchestratorService } from 'src/modules/ai/infrastructure/routing/ai-orchestrator.service';
import { AIErrorClassifierService } from 'src/modules/ai/infrastructure/routing/ai-error-classifier.service';
import { ProviderHealthRegistry } from 'src/modules/ai/infrastructure/routing/provider-health.registry';
import { ModelRouterService } from 'src/modules/ai/infrastructure/routing/model-router.service';
import type { AnthropicJsonExecutor } from 'src/modules/ai/infrastructure/providers/anthropic/anthropic-json.executor';
import type { AnthropicClient } from 'src/modules/ai/infrastructure/clients/anthropic.client';
import type { OpenAIClient } from 'src/modules/ai/infrastructure/clients/openai.client';

/**
 * As três propriedades que este contrato existe para ter, e que o gerador de
 * prosa **não** tem:
 *
 * 1. JSON atravessa intacto — nada de aspas removidas nem de corte em fronteira
 *    de frase;
 * 2. resposta fora do contrato é falha da rota, não sucesso silencioso;
 * 3. o fallback em memória fica de fora, porque não existe texto de anúncio
 *    honesto que uma constante possa escrever.
 */

const schema = z.object({
  variants: z
    .array(z.object({ angle: z.string(), primaryText: z.string() }))
    .min(1),
});

function build(overrides: {
  anthropicConfigured?: boolean;
  openAIConfigured?: boolean;
  anthropicAnswers?: string[];
  candidates?: { provider: string; model: string }[];
}) {
  const answers = [...(overrides.anthropicAnswers ?? [])];

  const anthropicJson = {
    execute: jest.fn(async () => ({
      text: answers.shift() ?? '',
      inputTokens: 120,
      outputTokens: 340,
    })),
  } as unknown as AnthropicJsonExecutor;

  const anthropicClient = {
    isConfigured: () => overrides.anthropicConfigured ?? true,
  } as unknown as AnthropicClient;

  const openAIClient = {
    isConfigured: () => overrides.openAIConfigured ?? false,
  } as unknown as OpenAIClient;

  const router = {
    getCandidates: () =>
      overrides.candidates ?? [
        { provider: 'anthropic', model: 'claude-copy' },
        { provider: 'anthropic', model: 'claude-fallback' },
        { provider: 'memory', model: 'memory-fallback' },
      ],
  } as unknown as ModelRouterService;

  // Classificador e registry reais: o que se verifica aqui é a política que
  // emerge dos três colaborando, não o dublê de cada um.
  const env = { get: jest.fn(() => 30_000) };
  const orchestrator = new AIOrchestratorService(
    router,
    new AIErrorClassifierService(),
    new ProviderHealthRegistry(env as never),
  );

  return {
    provider: new RoutedStructuredGenerationProvider(
      anthropicJson,
      anthropicClient,
      openAIClient,
      orchestrator,
    ),
    anthropicJson,
  };
}

const valid = JSON.stringify({
  variants: [{ angle: 'BENEFIT', primaryText: 'Pare de perder horas.' }],
});

describe('geração estruturada — o JSON chega inteiro', () => {
  it('devolve o objeto validado, com provider, modelo e tokens', async () => {
    const { provider } = build({ anthropicAnswers: [valid] });

    const result = await provider.generateJson({
      task: 'creative_suggestion',
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema,
      maxTokens: 2000,
    });

    expect(result.value.variants[0].primaryText).toBe('Pare de perder horas.');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-copy');
    // Sem tokens, o teto diário compararia sempre zero contra o limite — e esta
    // é a tarefa que roteia para o modelo mais caro do catálogo.
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(340);
    expect(result.fallbackUsed).toBe(false);
  });

  it('aceita JSON dentro de cerca de markdown', async () => {
    const { provider } = build({
      anthropicAnswers: ['```json\n' + valid + '\n```'],
    });

    const result = await provider.generateJson({
      task: 'creative_suggestion',
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema,
      maxTokens: 2000,
    });

    expect(result.value.variants).toHaveLength(1);
  });
});

describe('geração estruturada — resposta fora do contrato é falha da rota', () => {
  it('cai para o próximo candidato quando o schema não casa', async () => {
    // O primeiro devolve JSON válido com os campos errados: é a falha que de
    // fato acontece, e a que o modo JSON do provider não pega.
    const { provider } = build({
      anthropicAnswers: [JSON.stringify({ variants: [] }), valid],
    });

    const result = await provider.generateJson({
      task: 'creative_suggestion',
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema,
      maxTokens: 2000,
    });

    expect(result.model).toBe('claude-fallback');
    expect(result.fallbackUsed).toBe(true);
  });

  it('quando toda a rota falha, lança — nunca devolve objeto meio preenchido', async () => {
    const { provider } = build({ anthropicAnswers: ['isto não é json', '{}'] });

    await expect(
      provider.generateJson({
        task: 'creative_suggestion',
        systemPrompt: 'sys',
        userPrompt: 'user',
        schema,
        maxTokens: 2000,
      }),
    ).rejects.toThrow();
  });
});

describe('geração estruturada — o fallback em memória fica de fora', () => {
  it('não usa `memory` nem quando é o único candidato restante', async () => {
    const { provider, anthropicJson } = build({
      anthropicConfigured: false,
      candidates: [
        { provider: 'anthropic', model: 'claude-copy' },
        { provider: 'memory', model: 'memory-fallback' },
      ],
    });

    /**
     * Sem provider, a resposta certa é **nenhuma variante** — e é o serviço de
     * geração que a transforma em `AI_UNAVAILABLE` com a sugestão preservada.
     * Uma constante escrevendo texto de anúncio apareceria na tela idêntica a
     * uma variante gerada, e a pessoa poderia publicá-la sob a marca dela.
     */
    await expect(
      provider.generateJson({
        task: 'creative_suggestion',
        systemPrompt: 'sys',
        userPrompt: 'user',
        schema,
        maxTokens: 2000,
      }),
    ).rejects.toThrow();

    expect(anthropicJson.execute).not.toHaveBeenCalled();
  });
});
