import { Request } from 'express';
import {
  CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
  parseTrustProxySetting,
  resolveClientIp,
  verifiedClientIpMiddleware,
} from './client-ip';

function requestWith(overrides: Partial<Request> = {}): Request {
  return { headers: {}, socket: {}, ...overrides } as unknown as Request;
}

describe('resolveClientIp', () => {
  it('uses req.ip, which express resolved against `trust proxy`', () => {
    expect(resolveClientIp(requestWith({ ip: '203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('ignores a client-supplied X-Forwarded-For when express rejected it', () => {
    // The regression this replaced: reading X-Forwarded-For[0] took the left-most
    // entry — the one the caller wrote. Rotating that header handed an attacker a
    // fresh per-IP login budget on every request.
    const req = requestWith({
      ip: '203.0.113.7',
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    } as Partial<Request>);

    expect(resolveClientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to X-Real-IP only when express produced nothing', () => {
    const req = requestWith({
      headers: { 'x-real-ip': ' 198.51.100.4 ' },
    } as Partial<Request>);

    expect(resolveClientIp(req)).toBe('198.51.100.4');
  });

  it('falls back to the socket address as a last resort', () => {
    const req = requestWith({
      socket: { remoteAddress: '10.0.0.9' },
    } as Partial<Request>);

    expect(resolveClientIp(req)).toBe('10.0.0.9');
  });

  it('returns undefined when nothing identifies the caller', () => {
    expect(resolveClientIp(requestWith())).toBeUndefined();
  });
});

describe('parseTrustProxySetting', () => {
  it('defaults to a single hop when unset', () => {
    expect(parseTrustProxySetting(undefined)).toBe(1);
    expect(parseTrustProxySetting('  ')).toBe(1);
  });

  it('accepts a hop count', () => {
    expect(parseTrustProxySetting('2')).toBe(2);
    expect(parseTrustProxySetting('0')).toBe(0);
  });

  it('accepts an explicit boolean', () => {
    expect(parseTrustProxySetting('false')).toBe(false);
    expect(parseTrustProxySetting('true')).toBe(true);
  });

  it('parses a proxy list, which is the safe production form', () => {
    expect(parseTrustProxySetting('10.0.0.0/8, 172.16.0.1 ,loopback')).toEqual([
      '10.0.0.0/8',
      '172.16.0.1',
      'loopback',
    ]);
  });
});

/**
 * GAP-033: Vercel → Cloudflare → API. Só o nosso proxy, provado pelo segredo,
 * pode declarar o IP do visitante; o resto continua em `req.ip`.
 */
describe('verifiedClientIpMiddleware (GAP-033)', () => {
  const SECRET = 's'.repeat(40);

  function run(secret: string | undefined, headers: Record<string, string>) {
    const req = requestWith({
      ip: '76.76.21.9', // saída da Vercel, como o Express a resolveria
      headers: { ...headers },
    } as Partial<Request>);
    const next = jest.fn();
    verifiedClientIpMiddleware(secret)(req, {} as never, next);
    return { req, next };
  }

  it('aceita o IP declarado quando o segredo confere', () => {
    const { req, next } = run(SECRET, {
      [CLIENT_IP_HEADER]: '189.10.20.30',
      [PROXY_SECRET_HEADER]: SECRET,
    });

    expect(next).toHaveBeenCalled();
    expect(resolveClientIp(req)).toBe('189.10.20.30');
  });

  it.each([
    ['segredo errado', { [PROXY_SECRET_HEADER]: 'x'.repeat(40) }],
    ['segredo de outro tamanho', { [PROXY_SECRET_HEADER]: 'curto' }],
    ['sem segredo', {}],
  ])('ignora o IP declarado com %s', (_label, extra) => {
    const { req } = run(SECRET, {
      [CLIENT_IP_HEADER]: '189.10.20.30',
      ...extra,
    });

    expect(resolveClientIp(req)).toBe('76.76.21.9');
  });

  it('ignora um valor que não é IP, mesmo com o segredo certo', () => {
    const { req } = run(SECRET, {
      [CLIENT_IP_HEADER]: '189.10.20.30, 1.1.1.1',
      [PROXY_SECRET_HEADER]: SECRET,
    });

    expect(resolveClientIp(req)).toBe('76.76.21.9');
  });

  // Sem a variável, o comportamento é o de antes: ninguém declara IP.
  it('sem TRUSTED_CLIENT_IP_SECRET, nada muda', () => {
    const { req } = run(undefined, {
      [CLIENT_IP_HEADER]: '189.10.20.30',
      [PROXY_SECRET_HEADER]: '',
    });

    expect(resolveClientIp(req)).toBe('76.76.21.9');
  });

  // O segredo não pode seguir para log, auditoria nem controller.
  it('tira os dois cabeçalhos da requisição, aceitos ou não', () => {
    const { req } = run(SECRET, {
      [CLIENT_IP_HEADER]: '189.10.20.30',
      [PROXY_SECRET_HEADER]: SECRET,
    });

    expect(req.headers[CLIENT_IP_HEADER]).toBeUndefined();
    expect(req.headers[PROXY_SECRET_HEADER]).toBeUndefined();
  });

  it('aceita IPv6', () => {
    const { req } = run(SECRET, {
      [CLIENT_IP_HEADER]: '2804:14c::1',
      [PROXY_SECRET_HEADER]: SECRET,
    });

    expect(resolveClientIp(req)).toBe('2804:14c::1');
  });
});
