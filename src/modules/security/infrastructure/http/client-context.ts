import { Request } from 'express';
import { resolveClientIp } from 'src/shared/infrastructure/http/client-ip';

export type ClientContext = {
  ipAddress?: string;
  userAgent?: string;
};

/**
 * Single source of truth for deriving the caller's IP and user-agent, shared by
 * security logging, the brute-force lockout and the rate limiter.
 *
 * It used to read `X-Forwarded-For[0]` — the left-most entry, which is whatever
 * the *client* sent. That made both the audit trail and the per-IP login throttle
 * take the attacker's word for who they were: rotating the header produced a fresh
 * budget every request. Resolution now goes through `trust proxy`, so the trust
 * boundary is configured in one place instead of assumed here.
 */
export function extractClientContext(req: Request): ClientContext {
  return {
    ipAddress: resolveClientIp(req),
    userAgent: req.get('user-agent') ?? undefined,
  };
}

export type RequestWithClientContext = Request & {
  clientContext?: ClientContext;
};
