import { ClassifiedAIError } from './ai-error-classifier.service';
import { ModelCandidate } from './ai-task.types';
import { ProviderHealthRegistry } from './provider-health.registry';

const OPENAI: ModelCandidate = { provider: 'openai', model: 'gpt-4o-mini' };
const ANTHROPIC: ModelCandidate = {
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-latest',
};

function failure(
  overrides: Partial<ClassifiedAIError> & Pick<ClassifiedAIError, 'code'>,
): ClassifiedAIError {
  return {
    retryable: true,
    fallbackable: true,
    message: 'boom',
    ...overrides,
  };
}

function buildRegistry(baseCooldownMs = 30_000) {
  const env = { get: jest.fn(() => baseCooldownMs) };

  return new ProviderHealthRegistry(env as any);
}

describe('ProviderHealthRegistry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with every candidate available', () => {
    const registry = buildRegistry();

    expect(registry.isAvailable(OPENAI)).toBe(true);
    expect(registry.cooldownRemainingMs(OPENAI)).toBe(0);
  });

  it.each(['rate_limit', 'capacity', 'server_error'] as const)(
    'parks a provider after a %s failure',
    (code) => {
      const registry = buildRegistry();

      registry.reportFailure(OPENAI, failure({ code }));

      expect(registry.isAvailable(OPENAI)).toBe(false);
      // Only the failing pair is parked; the rest of the route stays open.
      expect(registry.isAvailable(ANTHROPIC)).toBe(true);
    },
  );

  it.each(['bad_request', 'invalid_response', 'unknown'] as const)(
    'does not park a provider for a %s failure',
    (code) => {
      const registry = buildRegistry();

      registry.reportFailure(OPENAI, failure({ code }));

      expect(registry.isAvailable(OPENAI)).toBe(true);
    },
  );

  it('parks for exactly as long as Retry-After asked', () => {
    const registry = buildRegistry(30_000);

    registry.reportFailure(
      OPENAI,
      failure({ code: 'rate_limit', retryAfterMs: 90_000 }),
    );

    expect(registry.cooldownRemainingMs(OPENAI)).toBeGreaterThan(85_000);
    expect(registry.cooldownRemainingMs(OPENAI)).toBeLessThanOrEqual(90_000);
  });

  it('keeps the longer cooldown when a shorter failure follows', () => {
    const registry = buildRegistry(1_000);

    registry.reportFailure(
      OPENAI,
      failure({ code: 'rate_limit', retryAfterMs: 60_000 }),
    );
    registry.reportFailure(OPENAI, failure({ code: 'timeout' }));

    expect(registry.cooldownRemainingMs(OPENAI)).toBeGreaterThan(50_000);
  });

  it('caps absurd Retry-After hints', () => {
    const registry = buildRegistry();

    registry.reportFailure(
      OPENAI,
      failure({ code: 'rate_limit', retryAfterMs: 60 * 60_000 }),
    );

    expect(registry.cooldownRemainingMs(OPENAI)).toBeLessThanOrEqual(
      5 * 60_000,
    );
  });

  it('releases the provider once the cooldown elapses', () => {
    jest.useFakeTimers();
    const registry = buildRegistry(30_000);

    registry.reportFailure(OPENAI, failure({ code: 'capacity' }));
    expect(registry.isAvailable(OPENAI)).toBe(false);

    jest.advanceTimersByTime(30_001);

    expect(registry.isAvailable(OPENAI)).toBe(true);
  });

  it('clears the cooldown on a successful call', () => {
    const registry = buildRegistry();

    registry.reportFailure(OPENAI, failure({ code: 'capacity' }));
    registry.reportSuccess(OPENAI);

    expect(registry.isAvailable(OPENAI)).toBe(true);
  });
});
