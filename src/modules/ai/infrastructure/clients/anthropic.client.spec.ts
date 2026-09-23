import { UnauthorizedException } from '@nestjs/common';
import { AnthropicClient } from './anthropic.client';

function buildClient() {
  const env = { get: jest.fn(() => 45_000) };

  return new AnthropicClient(env as any);
}

describe('AnthropicClient', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('constructs without a key so a missing optional provider cannot break boot', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => buildClient()).not.toThrow();
    expect(buildClient().isConfigured()).toBe(false);
  });

  it('reports itself configured once a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    expect(buildClient().isConfigured()).toBe(true);
  });

  it('ignores a blank key', () => {
    process.env.ANTHROPIC_API_KEY = '   ';

    expect(buildClient().isConfigured()).toBe(false);
  });

  it('only fails when a call is actually attempted without a key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const client = buildClient();

    await expect(
      client.createMessage({ model: 'claude', system: 'sys', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
