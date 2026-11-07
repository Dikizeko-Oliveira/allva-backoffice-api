import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';

/** IP do visitante, declarado pelo BFF (GAP-033). */
export const CLIENT_IP_HEADER = 'x-allva-client-ip';
/** Segredo que prova que quem declarou o IP é um proxy nosso. */
export const PROXY_SECRET_HEADER = 'x-allva-proxy-secret';

type RequestWithVerifiedIp = Request & { verifiedClientIp?: string };

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
  // Declared by our own proxy and proven by the shared secret (GAP-033): wins
  // over `req.ip`, which behind Vercel → Cloudflare is the Vercel egress.
  const verified = (req as RequestWithVerifiedIp).verifiedClientIp;
  if (verified) return verified;

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

/**
 * O IP do visitante que o **nosso** proxy declara (GAP-033, 2026-11-05).
 *
 * A cadeia de produção é navegador → Vercel (BFF) → Cloudflare → API, sem Nginx.
 * O Cloudflare tem faixas publicadas; a saída da Vercel muda e não se lista. Com
 * isso, `trust proxy` só oferecia duas respostas ruins:
 *
 * - confiar nas faixas do Cloudflare: todo usuário do app aparece com o IP de
 *   saída da Vercel e divide o balde do throttle e o lockout;
 * - confiar em dois saltos: qualquer um que chame `api.allva.com.br` direto
 *   escreve o próprio `X-Forwarded-For` e escolhe o IP — throttle e lockout por
 *   IP deixam de existir.
 *
 * A saída é o proxy **se identificar**: o BFF (e o backoffice-api) mandam o IP
 * em `x-allva-client-ip` junto com `x-allva-proxy-secret`. O IP só é aceito se
 * o segredo confere (comparação em tempo constante) e se é um IP válido. Os
 * dois cabeçalhos saem da requisição aqui mesmo, aceitos ou não: o segredo não
 * segue para log, auditoria nem controller.
 *
 * Sem `TRUSTED_CLIENT_IP_SECRET` configurado, nada muda — vale `req.ip`.
 */
export function verifiedClientIpMiddleware(secret: string | undefined) {
  const expected = secret ? Buffer.from(secret) : null;

  return (req: Request, _res: Response, next: NextFunction): void => {
    const declared = headerValue(req, CLIENT_IP_HEADER);
    const presented = headerValue(req, PROXY_SECRET_HEADER);

    delete req.headers[CLIENT_IP_HEADER];
    delete req.headers[PROXY_SECRET_HEADER];

    if (expected && declared && presented && isIP(declared)) {
      const given = Buffer.from(presented);
      if (
        given.length === expected.length &&
        timingSafeEqual(given, expected)
      ) {
        (req as RequestWithVerifiedIp).verifiedClientIp = declared;
      }
    }

    next();
  };
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}
