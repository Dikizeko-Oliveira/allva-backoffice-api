import { AIErrorClassifierService } from './ai-error-classifier.service';

/** Mimics the shape provider SDKs throw: an Error carrying status + headers. */
function providerError(
  message: string,
  status?: number,
  headers?: Record<string, string>,
) {
  return Object.assign(new Error(message), { status, headers });
}

describe('AIErrorClassifierService', () => {
  const classifier = new AIErrorClassifierService();

  it.each([
    [429, 'rate_limit', true, true],
    [529, 'capacity', true, true],
    [503, 'capacity', true, true],
    [408, 'timeout', true, true],
    [500, 'server_error', true, true],
    [502, 'server_error', true, true],
  ])(
    'treats status %i as %s (retryable/fallbackable)',
    (status, code, retryable, fallbackable) => {
      const result = classifier.classify(
        providerError('provider said no', status),
      );

      expect(result).toMatchObject({ code, retryable, fallbackable, status });
    },
  );

  it('does not retry an auth failure but still falls back to another provider', () => {
    const result = classifier.classify(providerError('bad key', 401));

    expect(result).toMatchObject({
      code: 'auth',
      retryable: false,
      fallbackable: true,
    });
  });

  it('stops the whole route when our own payload is rejected', () => {
    const result = classifier.classify(providerError('bad payload', 400));

    expect(result).toMatchObject({
      code: 'bad_request',
      retryable: false,
      fallbackable: false,
    });
  });

  it('prefers the status over misleading words in the message', () => {
    // Message mentions a rate limit, but the provider actually returned 400.
    const result = classifier.classify(
      providerError('rate limit rules explained', 400),
    );

    expect(result.code).toBe('bad_request');
  });

  it('reads Retry-After given in seconds', () => {
    const result = classifier.classify(
      providerError('slow down', 429, { 'retry-after': '12' }),
    );

    expect(result.retryAfterMs).toBe(12_000);
  });

  it('reads Retry-After given as an http date', () => {
    const inThirtySeconds = new Date(Date.now() + 30_000).toUTCString();
    const result = classifier.classify(
      providerError('slow down', 429, { 'retry-after': inThirtySeconds }),
    );

    expect(result.retryAfterMs).toBeGreaterThan(25_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it('reads Retry-After from a Headers instance', () => {
    const error = Object.assign(new Error('slow down'), {
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
    });

    expect(classifier.classify(error).retryAfterMs).toBe(5_000);
  });

  it.each([
    ['ECONNRESET', 'network'],
    ['ETIMEDOUT', 'timeout'],
  ])('classifies socket error %s as %s', (code, expected) => {
    const error = Object.assign(new Error('socket blew up'), { code });

    expect(classifier.classify(error).code).toBe(expected);
  });

  it('falls back to the message when there is no status', () => {
    expect(classifier.classify(new Error('Engine is overloaded')).code).toBe(
      'capacity',
    );
    expect(classifier.classify(new Error('invalid json returned')).code).toBe(
      'invalid_response',
    );
  });

  it('treats an unrecognised failure as retryable and fallbackable', () => {
    expect(classifier.classify(new Error('¯\\_(ツ)_/¯'))).toMatchObject({
      code: 'unknown',
      retryable: true,
      fallbackable: true,
    });
  });
});
