import { ServiceUnavailableException } from '@nestjs/common';
import { AIErrorClassifierService } from './ai-error-classifier.service';
import { AIOrchestratorService } from './ai-orchestrator.service';
import { ModelCandidate } from './ai-task.types';
import { ProviderHealthRegistry } from './provider-health.registry';

const OPENAI: ModelCandidate = { provider: 'openai', model: 'gpt-4o-mini' };
const OPENAI_FALLBACK: ModelCandidate = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
};
const MEMORY: ModelCandidate = {
  provider: 'memory',
  model: 'memory-fallback',
};

/** Provider-shaped error: the classifier reads status and headers off it. */
function providerError(
  message: string,
  status: number,
  headers?: Record<string, string>,
) {
  return Object.assign(new Error(message), { status, headers });
}

function buildHarness(
  route: ModelCandidate[] = [OPENAI, OPENAI_FALLBACK, MEMORY],
) {
  const modelRouter = { getCandidates: jest.fn(() => route) };
  const env = { get: jest.fn(() => 30_000) };
  // Real classifier and registry: the point of these tests is the policy that
  // emerges from the three collaborating.
  const health = new ProviderHealthRegistry(env as any);
  const orchestrator = new AIOrchestratorService(
    modelRouter as any,
    new AIErrorClassifierService(),
    health,
  );

  return { orchestrator, modelRouter, health };
}

describe('AIOrchestratorService', () => {
  it('returns the first candidate that answers', async () => {
    const h = buildHarness();
    const execute = jest.fn().mockResolvedValue('ok');

    await expect(
      h.orchestrator.run({ task: 'creative_diagnosis', execute }),
    ).resolves.toEqual({
      result: 'ok',
      provider: 'openai',
      model: 'gpt-4o-mini',
      // Primeiro da rota: quem consome grava isto no log e compara custo por
      // provedor, então "não houve fallback" precisa ser afirmado, não inferido.
      fallbackUsed: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next provider when the first is out of capacity', async () => {
    const h = buildHarness();
    const execute = jest.fn((candidate: ModelCandidate) =>
      candidate.model === 'gpt-4o-mini'
        ? // Retry-After of 0: retried once without a real wait, then the route moves on.
          Promise.reject(
            providerError('overloaded', 529, { 'retry-after': '0' }),
          )
        : Promise.resolve('from fallback'),
    );

    const result = await h.orchestrator.run({
      task: 'creative_diagnosis',
      execute,
    });

    expect(result).toMatchObject({
      result: 'from fallback',
      model: 'gpt-4.1-mini',
    });
    // Two attempts on the saturated model, then one on the fallback.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('parks a rate limited model so the next call skips it entirely', async () => {
    const h = buildHarness();
    const execute = jest.fn((candidate: ModelCandidate) =>
      candidate.model === 'gpt-4o-mini'
        ? Promise.reject(
            providerError('slow down', 429, { 'retry-after': '30' }),
          )
        : Promise.resolve('from fallback'),
    );

    await h.orchestrator.run({ task: 'creative_diagnosis', execute });
    execute.mockClear();

    await h.orchestrator.run({ task: 'creative_diagnosis', execute });

    // Second call never touches the parked model — straight to the fallback.
    expect(
      execute.mock.calls.every(
        ([candidate]) => candidate.model !== 'gpt-4o-mini',
      ),
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not wait on a Retry-After longer than the backoff ceiling', async () => {
    const h = buildHarness();
    const execute = jest.fn((candidate: ModelCandidate) =>
      candidate.provider === 'openai'
        ? Promise.reject(
            providerError('slow down', 429, { 'retry-after': '600' }),
          )
        : Promise.resolve('memory'),
    );

    const startedAt = Date.now();
    await h.orchestrator.run({ task: 'creative_diagnosis', execute });

    // Each openai model is tried once and abandoned rather than slept on.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('aborts the whole route when the request itself is invalid', async () => {
    const h = buildHarness();
    const execute = jest
      .fn()
      .mockRejectedValue(providerError('malformed payload', 400));

    await expect(
      h.orchestrator.run({ task: 'creative_diagnosis', execute }),
    ).rejects.toThrow('malformed payload');
    // No point asking another provider to reject the same payload.
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('skips a provider the caller disallows', async () => {
    const h = buildHarness();
    const execute = jest.fn().mockResolvedValue('ok');

    const result = await h.orchestrator.run({
      task: 'creative_diagnosis',
      execute,
      canUseCandidate: (candidate) => candidate.model !== 'gpt-4o-mini',
    });

    expect(result.model).toBe('gpt-4.1-mini');
  });

  it('tries the full route anyway when every candidate is cooling down', async () => {
    const h = buildHarness([OPENAI, OPENAI_FALLBACK]);
    h.health.reportFailure(OPENAI, {
      code: 'capacity',
      retryable: true,
      fallbackable: true,
      message: 'overloaded',
    });
    h.health.reportFailure(OPENAI_FALLBACK, {
      code: 'capacity',
      retryable: true,
      fallbackable: true,
      message: 'overloaded',
    });
    const execute = jest.fn().mockResolvedValue('recovered');

    await expect(
      h.orchestrator.run({ task: 'creative_diagnosis', execute }),
    ).resolves.toMatchObject({ result: 'recovered' });
  });

  it('clears the cooldown once the provider answers again', async () => {
    const h = buildHarness();
    h.health.reportFailure(OPENAI, {
      code: 'capacity',
      retryable: true,
      fallbackable: true,
      message: 'overloaded',
    });
    expect(h.health.isAvailable(OPENAI)).toBe(false);

    // Only OPENAI is allowed, so the run has to use the parked candidate.
    await h.orchestrator.run({
      task: 'creative_diagnosis',
      execute: jest.fn().mockResolvedValue('ok'),
      canUseCandidate: (candidate) => candidate.model === 'gpt-4o-mini',
    });

    expect(h.health.isAvailable(OPENAI)).toBe(true);
  });

  it('reports every failure when the whole route is exhausted', async () => {
    const h = buildHarness([OPENAI, OPENAI_FALLBACK]);
    const execute = jest
      .fn()
      .mockRejectedValue(
        providerError('overloaded', 503, { 'retry-after': '0' }),
      );

    const thrown = (await h.orchestrator
      .run({ task: 'creative_diagnosis', execute })
      .catch((error: unknown) => error)) as ServiceUnavailableException;

    const response = thrown.getResponse() as {
      code: string;
      details: string[];
    };

    expect(response.code).toBe('AI_ORCHESTRATION_FAILED');
    // Every attempt is reported, with the classification that drove the routing.
    expect(response.details.join('\n')).toContain(
      'openai/gpt-4o-mini [capacity] status=503',
    );
    expect(response.details.join('\n')).toContain(
      'openai/gpt-4.1-mini [capacity] status=503',
    );
  });
});
