import { ServiceUnavailableException } from '@nestjs/common';
import { AIErrorClassifierService } from 'src/modules/ai/infrastructure/routing/ai-error-classifier.service';
import { AIOrchestratorService } from 'src/modules/ai/infrastructure/routing/ai-orchestrator.service';
import { ModelCandidate } from 'src/modules/ai/infrastructure/routing/ai-task.types';
import { ProviderHealthRegistry } from 'src/modules/ai/infrastructure/routing/provider-health.registry';
import { MemoryAIProvider } from 'src/modules/ai/infrastructure/providers/memory/memory-ai.provider';
import {
  RoutedTextGenerationProvider,
  trimToBoundary,
} from './routed-text-generation.provider';

const OPENAI: ModelCandidate = { provider: 'openai', model: 'gpt-4o-mini' };
const ANTHROPIC: ModelCandidate = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-latest',
};
const MEMORY: ModelCandidate = { provider: 'memory', model: 'memory-fallback' };

const INPUT = {
  task: 'ad_narrative' as const,
  systemPrompt: 'sys',
  userPrompt: 'user',
  maxCharacters: 60,
};

function buildHarness(options: {
  route?: ModelCandidate[];
  openAIContent?: string | null;
  anthropicText?: string;
}) {
  const route = options.route ?? [OPENAI, ANTHROPIC, MEMORY];

  const create = jest.fn().mockResolvedValue({
    choices: [{ message: { content: options.openAIContent ?? null } }],
  });
  const openAIClient = { client: { chat: { completions: { create } } } };

  const createMessage = jest.fn().mockResolvedValue({
    text: options.anthropicText ?? 'Titulo da Anthropic',
  });
  const anthropicClient = { createMessage };

  const modelRouter = { getCandidates: jest.fn(() => route) };
  const env = { get: jest.fn(() => 30_000) };
  // Real orchestrator, classifier and registry: the behaviour under test is
  // what emerges from the provider collaborating with them.
  const orchestrator = new AIOrchestratorService(
    modelRouter as any,
    new AIErrorClassifierService(),
    new ProviderHealthRegistry(env as any),
  );

  const provider = new RoutedTextGenerationProvider(
    openAIClient as any,
    anthropicClient as any,
    new MemoryAIProvider(),
    orchestrator,
  );

  for (const level of ['log', 'warn'] as const) {
    jest
      .spyOn((orchestrator as any).logger, level)
      .mockImplementation(() => {});
  }

  return { provider, create, createMessage };
}

describe('RoutedTextGenerationProvider', () => {
  it('returns the first usable answer', async () => {
    const h = buildHarness({ openAIContent: 'Anuncios que vendem mais' });

    await expect(
      h.provider.generateText(INPUT).then((r) => r.text),
    ).resolves.toBe('Anuncios que vendem mais');
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  /**
   * THE GAP THIS CLOSES. Sanitising used to happen after `orchestrator.run`
   * returned, so a provider answering with empty content counted as a success:
   * the orchestrator marked it healthy and returned, and the emptiness surfaced
   * as a 503 with the rest of the route never tried — including the memory
   * fallback, which cannot come back empty.
   */
  it('falls through to the next provider when one answers empty', async () => {
    const h = buildHarness({
      openAIContent: '',
      anthropicText: 'Titulo da Anthropic',
    });

    await expect(
      h.provider.generateText(INPUT).then((r) => r.text),
    ).resolves.toBe('Titulo da Anthropic');
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retry the same model on an empty answer', async () => {
    const h = buildHarness({ openAIContent: '' });

    await h.provider.generateText(INPUT);

    // `invalid_response` is fallbackable but not retryable — asking the same
    // model again would just burn the request budget.
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('reaches the memory fallback when every real provider answers empty', async () => {
    const h = buildHarness({ openAIContent: '', anthropicText: '   ' });

    await expect(
      h.provider.generateText(INPUT).then((r) => r.text),
    ).resolves.toBe(
      // O fallback declara a ausência em vez de inventar conteúdo: a redação
      // anterior devolvia uma copy pronta ("Anúncios mais inteligentes…") como
      // se um modelo a tivesse escrito para este anúncio.
      // Truncado por `maxCharacters`, que é o comportamento do provider — o
      // fallback declara a ausência, e o corte é do transporte, não do conteúdo.
      'Não foi possível gerar a leitura em linguagem natural agora.',
    );
  });

  it('still fails loudly when the route is exhausted', async () => {
    const h = buildHarness({ route: [OPENAI], openAIContent: '' });

    await expect(h.provider.generateText(INPUT)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('strips quoting and the label prefix, then trims on a word boundary', async () => {
    const h = buildHarness({ openAIContent: '"Titulo: Venda mais hoje"' });

    // Antes cortava em 'Venda mais h'. Palavra partida ao meio lê como produto
    // quebrado — a reticência declara que há mais texto, e cabe no orçamento.
    await expect(
      h.provider
        .generateText({ ...INPUT, maxCharacters: 12 })
        .then((r) => r.text),
    ).resolves.toBe('Venda mais…');
  });
});

describe('trimToBoundary', () => {
  it('leaves text under the budget untouched', () => {
    expect(trimToBoundary('Curto e completo.', 400)).toBe('Curto e completo.');
  });

  it('prefers the last sentence end inside the budget', () => {
    const text =
      'O anúncio manteve entrega estável na janela analisada. ' +
      'A aderência ao público ficou acima da mediana do conjunto. ' +
      'A fadiga cresceu no fim do período e merece acompanhamento.';

    const trimmed = trimToBoundary(text, 120);

    // O **último** fim de frase que cabe, não o primeiro: as duas frases somam
    // 114 de 120 caracteres, e parar na primeira jogaria fora metade do que
    // coube sem nenhum ganho.
    expect(trimmed).toBe(
      'O anúncio manteve entrega estável na janela analisada. ' +
        'A aderência ao público ficou acima da mediana do conjunto.',
    );
    expect(trimmed.endsWith('.')).toBe(true);
  });

  it('falls back to a word boundary when the first sentence ends too early', () => {
    // O fim de frase está em ~8% do orçamento: cortar ali jogaria fora quase
    // tudo que o modelo explicou, então vale mais o corte declarado.
    const text = 'Tudo bem. ' + 'palavra '.repeat(40);

    const trimmed = trimToBoundary(text, 120);

    expect(trimmed.endsWith('…')).toBe(true);
    expect(trimmed.length).toBeLessThanOrEqual(120);
    expect(trimmed).not.toMatch(/palavr…$/);
  });

  it('never exceeds the budget, ellipsis included', () => {
    const trimmed = trimToBoundary('a'.repeat(50) + ' ' + 'b'.repeat(50), 60);

    expect(trimmed.length).toBeLessThanOrEqual(60);
  });

  it('does not treat a decimal point as the end of a sentence', () => {
    const text =
      'O investimento acumulado na janela foi de R$ 1.234,56 no total geral ' +
      'e seguiu dentro do teto diário previsto para o período analisado.';

    const trimmed = trimToBoundary(text, 70);

    // O ponto de "1.234,56" não é fim de frase: o valor sai inteiro, e o corte
    // acontece numa fronteira de palavra depois dele.
    expect(trimmed).toContain('R$ 1.234,56');
    expect(trimmed.endsWith('…')).toBe(true);
  });
});
