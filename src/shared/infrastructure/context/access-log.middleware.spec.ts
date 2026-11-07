import { EventEmitter } from 'events';
import { Response } from 'express';
import { AccessLogMiddleware, pathOf } from './access-log.middleware';
import { RequestWithCorrelation } from './correlation-id.middleware';

function run(
  req: Partial<RequestWithCorrelation>,
  statusCode: number,
): {
  log: jest.SpyInstance;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
  next: jest.Mock;
} {
  const middleware = new AccessLogMiddleware();
  const logger = (middleware as any).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const res = Object.assign(new EventEmitter(), { statusCode });
  const next = jest.fn();

  middleware.use(
    req as RequestWithCorrelation,
    res as unknown as Response,
    next,
  );
  res.emit('finish');

  return { log, warn, error, next };
}

describe('AccessLogMiddleware (GAP-058)', () => {
  it('uma linha com método, caminho, status e o correlationId', () => {
    const { log, next } = run(
      { method: 'GET', originalUrl: '/api/v1/ads', correlationId: 'bff-123' },
      200,
    );

    expect(next).toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^http method=GET path=\/api\/v1\/ads status=200 ms=\d+\.\d correlationId=bff-123$/,
    );
  });

  // SEC-15: a query de algumas rotas é credencial.
  it('nunca registra a query', () => {
    const { log } = run(
      {
        method: 'GET',
        originalUrl: '/api/v1/integrations/meta/callback?code=abc&state=xyz',
        correlationId: 'c',
      },
      302,
    );

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('path=/api/v1/integrations/meta/callback ');
    expect(line).not.toContain('code=');
    expect(line).not.toContain('state=');
  });

  it.each([
    [404, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ] as const)('HTTP %i sai em %s', (status, level) => {
    const spies = run(
      { method: 'POST', originalUrl: '/x', correlationId: 'c' },
      status,
    );

    expect(spies[level]).toHaveBeenCalledTimes(1);
  });

  it.each([
    { method: 'GET', originalUrl: '/api/v1/health' },
    { method: 'GET', originalUrl: '/api/v1/health?probe=1' },
    { method: 'OPTIONS', originalUrl: '/api/v1/ads' },
  ])('não registra $method $originalUrl', (req) => {
    const { log, warn, error, next } = run(req, 200);

    expect(next).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('AccessLogMiddleware — requisição incompleta', () => {
  // Fora do Express completo (teste, adaptador) originalUrl pode faltar.
  it('cai em req.url quando não há originalUrl', () => {
    const { log } = run({ method: 'GET', url: '/api/v1/plans?x=1' }, 200);

    expect(String(log.mock.calls[0][0])).toContain('path=/api/v1/plans ');
  });

  it('sem url nenhuma, registra caminho vazio em vez de quebrar', () => {
    const { log } = run({ method: 'GET' }, 200);

    expect(String(log.mock.calls[0][0])).toContain('path= ');
  });

  it('sem correlationId, registra "-"', () => {
    const { log } = run({ method: 'GET', originalUrl: '/x' }, 200);

    expect(String(log.mock.calls[0][0])).toMatch(/correlationId=-$/);
  });
});

describe('pathOf', () => {
  it.each([
    ['/a/b?x=1', '/a/b'],
    ['/a#f', '/a'],
    ['/a', '/a'],
  ])('%s → %s', (raw, expected) => {
    expect(pathOf(raw)).toBe(expected);
  });
});
