import { Request } from 'express';

/**
 * The caller's IP, as far as this process is allowed to believe it.
 *
 * Behind the Next BFF every request arrives on a socket owned by the proxy, so the
 * socket address identifies the proxy and not the visitor. `req.ip` is Express's
 * answer after applying `trust proxy` to `X-Forwarded-For`, which makes it the only
 * value derived from the configured trust boundary — and therefore the only one
 * safe to key a rate limit or a brute-force lockout on.
 *
 * Reading `X-Forwarded-For[0]` directly, as the security context used to, takes the
 * left-most entry: the one the *client* wrote. Anyone could set that header and
 * collect a fresh per-IP budget on every request, which is precisely the protection
 * the login throttle was meant to provide.
 */
export function resolveClientIp(req: Request): string | undefined {
  // Express already resolved this against `trust proxy`; when the app trusts no
  // proxy it is the socket address, which is the correct conservative answer.
  if (req.ip) return req.ip;

  // Some proxies forward only X-Real-IP. Consulted *after* req.ip so a configured
  // trust boundary always wins — never as a way around one.
  const realIp = req.headers?.['x-real-ip'];
  const candidate = Array.isArray(realIp) ? realIp[0] : realIp;

  return candidate?.trim() || req.socket?.remoteAddress || undefined;
}

/**
 * Parses `TRUSTED_PROXIES` into an Express `trust proxy` setting.
 *
 * Accepts a hop count (`1`), a comma-separated list of addresses/CIDRs, or one of
 * Express's presets (`loopback`, `uniquelocal`, …). Left unset it falls back to
 * trusting a single hop, which is right behind exactly one load balancer and is
 * what this app already assumed.
 *
 * The list form is the safer configuration: a hop count trusts whoever happens to
 * be the immediate peer, so a caller that reaches the API directly — bypassing the
 * balancer — is trusted to describe its own origin.
 */
export function parseTrustProxySetting(
  raw: string | undefined,
): boolean | number | string[] {
  const value = raw?.trim();

  if (!value) return 1;

  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 0) return hops;

  if (value === 'true') return true;
  if (value === 'false') return false;

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
