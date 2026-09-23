import { ModelRouterService } from './model-router.service';

function buildRouter(
  anthropicConfigured: boolean,
  openAIConfigured = true,
  envValues: Record<string, string | undefined> = {},
) {
  const anthropicClient = {
    isConfigured: jest.fn(() => anthropicConfigured),
  };
  const openAIClient = {
    isConfigured: jest.fn(() => openAIConfigured),
  };
  const env = { get: jest.fn((key: string) => envValues[key]) };

  return new ModelRouterService(
    anthropicClient as any,
    openAIClient as any,
    env as any,
  );
}

describe('ModelRouterService', () => {
  it('routes campaign analysis to openai first and keeps memory last', () => {
    const candidates = buildRouter(true).getCandidates('creative_diagnosis');

    expect(candidates[0].provider).toBe('openai');
    expect(candidates[candidates.length - 1]).toEqual({
      provider: 'memory',
      model: 'memory-fallback',
    });
  });

  it('routes copy generation to anthropic first when it is configured', () => {
    // `creative_suggestion` é a única tarefa cujo texto vira mídia — sai do
    // produto e entra num anúncio. É onde capacidade extra vira resultado, e
    // não custo por resultado igual.
    const candidates = buildRouter(true).getCandidates('creative_suggestion');

    expect(candidates[0].provider).toBe('anthropic');
  });

  it('routes high-volume narrative prose to openai first', () => {
    // As três tarefas que de fato rodam produzem 2 a 3 frases factuais sobre
    // números já apurados, e escalam com anúncios monitorados. Medido: 8,8× de
    // diferença de custo entre os dois modelos para a mesma saída.
    for (const task of [
      'ad_narrative',
      'daily_digest',
      'creative_diagnosis',
    ] as const) {
      expect(buildRouter(true).getCandidates(task)[0].provider).toBe('openai');
    }
  });

  it('keeps a cross-vendor candidate before the memory fallback', () => {
    // O que separa "queda de modelo" de "queda de fornecedor": sem este
    // candidato, qualquer incidente da OpenAI entrega texto enlatado a todo
    // mundo. Ele vem depois de duas tentativas, então não muda o custo.
    const providers = buildRouter(true)
      .getCandidates('ad_narrative')
      .map((c) => c.provider);

    expect(providers).toEqual(['openai', 'openai', 'anthropic', 'memory']);
  });

  it('drops anthropic entirely when no key is configured', () => {
    const candidates = buildRouter(false).getCandidates('ad_narrative');

    expect(candidates.some((c) => c.provider === 'anthropic')).toBe(false);
    // A rota tem de continuar utilizável: provedor real mais o fallback.
    expect(candidates.map((c) => c.provider)).toEqual([
      'openai',
      'openai',
      'memory',
    ]);
  });

  /**
   * The gap this fixes. `OpenAIClient.isConfigured()` existed and had no caller,
   * so an unconfigured OpenAI stayed on the route: the client threw on the
   * missing key, the classifier read it as `auth`, and the registry parked a
   * provider that was never coming back — every request, before the fallback.
   */
  it('drops openai entirely when no key is configured', () => {
    const candidates = buildRouter(true, false).getCandidates(
      'creative_diagnosis',
    );

    expect(candidates.some((c) => c.provider === 'openai')).toBe(false);
    expect(candidates.map((c) => c.provider)).toEqual(['anthropic', 'memory']);
  });

  it('falls back to memory alone when neither provider has a key', () => {
    const candidates = buildRouter(false, false).getCandidates(
      'creative_diagnosis',
    );

    expect(candidates).toEqual([
      { provider: 'memory', model: 'memory-fallback' },
    ]);
  });

  it('always ends on the memory fallback so a task can never be routeless', () => {
    for (const [anthropic, openai] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const router = buildRouter(anthropic, openai);

      for (const task of [
        'creative_diagnosis',
        'ad_narrative',
        'creative_suggestion',
      ] as const) {
        const candidates = router.getCandidates(task);

        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[candidates.length - 1].provider).toBe('memory');
      }
    }
  });

  it('honours model overrides from the validated config', () => {
    const candidates = buildRouter(false, true, {
      OPENAI_CAMPAIGN_ANALYSIS_MODEL: 'gpt-5-custom',
    }).getCandidates('creative_diagnosis');

    expect(candidates[0]).toEqual({
      provider: 'openai',
      model: 'gpt-5-custom',
    });
  });

  it('treats a blank override as absent instead of sending an empty model', () => {
    const blank = buildRouter(false, true, {
      OPENAI_CAMPAIGN_ANALYSIS_MODEL: '   ',
    }).getCandidates('creative_diagnosis');

    const absent = buildRouter(false, true, {}).getCandidates(
      'creative_diagnosis',
    );

    // Comparado com o caso sem override, e não com um literal: o default é
    // configuração que muda quando o provider lança modelo novo, e prender o
    // nome aqui faz esta asserção quebrar em toda troca — sem que o que ela
    // protege ("branco vira ausente, nunca string vazia") tenha mudado.
    expect(blank[0].model).toBe(absent[0].model);
    expect(blank[0].model.trim()).not.toBe('');
  });
});
