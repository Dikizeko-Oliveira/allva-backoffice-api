import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

/**
 * Rate-limit policies (PLAN.md §2.3 / risco do BFF).
 *
 * The API used to run one global throttler keyed on `req.ip`. Behind the Next BFF
 * every request arrives from the same address, so a single abusive account
 * consumed the budget of every other customer on that route, while an
 * authenticated caller had no per-identity limit at all.
 *
 * Each policy therefore declares *what it counts against*:
 *
 * - `public` — keyed by client IP. The only honest key when there is no identity
 *   yet: login, signup, password recovery, e-mail confirmation, public forms.
 * - `authenticated` — keyed by account id. One customer's traffic can no longer
 *   throttle another's, and the limit finally means "per user" as intended.
 * - `polling` — keyed by account id, sized for endpoints the UI polls on a timer
 *   (integration sync-status), so polling gets its own budget instead of eating
 *   the interactive one.
 *
 * Exactly one policy applies per request: the guard evaluates every named
 * throttler, so each one skips itself unless `resolveThrottlePolicy` elected it.
 * Without that they would stack and a route would silently answer to all three.
 */
export const THROTTLE_POLICIES = [
  'public',
  'authenticated',
  'polling',
] as const;

export type ThrottlePolicyName = (typeof THROTTLE_POLICIES)[number];

export type ThrottlePolicyLimit = { limit: number; ttl: number };

const ONE_MINUTE_MS = 60_000;

/**
 * Defaults per policy. Individual routes tighten these with `@ThrottleLimit` —
 * the sensitive auth routes do, and keep the numbers they had before.
 *
 * `public` is sized for **one visitor**, which assumes the BFF forwards the
 * visitor's address on every call. It is a deploy-ordering dependency, not a
 * preference: without that header every anonymous caller resolves to the proxy's
 * single IP and 20/min becomes a ceiling for the entire audience at once — the
 * landing page reads `GET /plans` on every view, so it is the first thing to fall.
 * Ship the BFF change first.
 */
export const THROTTLE_POLICY_LIMITS: Record<
  ThrottlePolicyName,
  ThrottlePolicyLimit
> = {
  public: { limit: 20, ttl: ONE_MINUTE_MS },
  authenticated: { limit: 300, ttl: ONE_MINUTE_MS },
  polling: { limit: 120, ttl: ONE_MINUTE_MS },
};

const THROTTLE_POLICY_METADATA = 'throttle:policy';

/**
 * Forces a policy on a route, overriding the automatic choice. Needed only where
 * the traffic shape differs from the caller's identity — a polled endpoint is
 * authenticated but should not share the interactive budget.
 */
export const ThrottlePolicy = (policy: ThrottlePolicyName) =>
  SetMetadata(THROTTLE_POLICY_METADATA, policy);

/**
 * Overrides the limit for a route under *whichever* policy ends up active.
 *
 * `@Throttle` targets a throttler by name, so a route annotated for one name goes
 * unlimited under the others. Since the active policy is decided at request time
 * (a route can be reached with or without a session), pinning a name is a bug
 * waiting to happen — this applies the same ceiling to all of them.
 */
export const ThrottleLimit = (limit: number, ttl: number = ONE_MINUTE_MS) =>
  Throttle(
    Object.fromEntries(
      THROTTLE_POLICIES.map((name) => [name, { limit, ttl }]),
    ) as Record<ThrottlePolicyName, ThrottlePolicyLimit>,
  );

/**
 * Exempts a route from every policy.
 *
 * Bare `@SkipThrottle()` only skips the throttler literally named `default`, which
 * no longer exists here — using it would have left the Stripe webhook rate limited
 * with no error and no test to notice.
 */
export const NoThrottle = () =>
  SkipThrottle(
    Object.fromEntries(THROTTLE_POLICIES.map((name) => [name, true])),
  );

// Reflector reads metadata off the handler; it has no dependencies, so a plain
// instance is enough for the `skipIf` closures the module factory builds.
const reflector = new Reflector();

type RequestWithUser = { user?: { id?: string } | null };

/**
 * The single policy that applies to this request.
 *
 * An explicit `@ThrottlePolicy` wins. Otherwise the presence of an authenticated
 * user decides it, which keeps every route correct with no annotation: public
 * routes have no `req.user` and fall to IP keying, authenticated ones key by
 * account.
 */
export function resolveThrottlePolicy(
  context: ExecutionContext,
): ThrottlePolicyName {
  const explicit = reflector.getAllAndOverride<ThrottlePolicyName | undefined>(
    THROTTLE_POLICY_METADATA,
    [context.getHandler(), context.getClass()],
  );

  if (explicit) return explicit;

  const request = context.switchToHttp().getRequest<RequestWithUser>();

  return request?.user?.id ? 'authenticated' : 'public';
}
