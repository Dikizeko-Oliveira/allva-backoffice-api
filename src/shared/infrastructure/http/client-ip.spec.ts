import { Request } from 'express';
import { parseTrustProxySetting, resolveClientIp } from './client-ip';

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
