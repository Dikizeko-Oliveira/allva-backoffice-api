import { ExecutionContext } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  NoThrottle,
  THROTTLE_POLICIES,
  THROTTLE_POLICY_LIMITS,
  ThrottleLimit,
  ThrottlePolicy,
  resolveThrottlePolicy,
} from './throttle-policies';

/** Minimal ExecutionContext: the policy resolver only reads these three. */
function contextFor({
  handler = function handler() {},
  classRef = class Controller {},
  user = null,
}: {
  handler?: object;
  classRef?: object;
  user?: { id: string } | null;
} = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** Applies a method decorator the way Nest does, returning the target. */
function decorate(decorator: MethodDecorator): object {
  const target = function handler() {};
  const descriptor = { value: target } as PropertyDescriptor;
  decorator({}, 'handler', descriptor);
  return target;
}

describe('resolveThrottlePolicy', () => {
  it('keys authenticated requests by policy `authenticated`', () => {
    expect(resolveThrottlePolicy(contextFor({ user: { id: 'acc-1' } }))).toBe(
      'authenticated',
    );
  });

  it('falls back to `public` when there is no user', () => {
    expect(resolveThrottlePolicy(contextFor({ user: null }))).toBe('public');
  });

  it('honours an explicit @ThrottlePolicy over the automatic choice', () => {
    const handler = decorate(ThrottlePolicy('polling') as MethodDecorator);

    expect(
      resolveThrottlePolicy(contextFor({ handler, user: { id: 'acc-1' } })),
    ).toBe('polling');
  });

  it('elects exactly one policy, so limits never stack', () => {
    // The guard evaluates every named throttler and each skips itself unless
    // elected. Two live policies on one request would silently apply both.
    const context = contextFor({ user: { id: 'acc-1' } });
    const elected = THROTTLE_POLICIES.filter(
      (name) => resolveThrottlePolicy(context) === name,
    );

    expect(elected).toHaveLength(1);
  });
});

/**
 * The library does not export its metadata-key constants, so these compare
 * against what its own decorators emit rather than hardcoding key strings — a
 * renamed key breaks the comparison instead of silently passing.
 */
function metadataOf(target: object): Record<string, unknown> {
  return Object.fromEntries(
    (Reflect.getOwnMetadataKeys(target) as string[]).map((key) => [
      key,
      Reflect.getOwnMetadata(key, target) as unknown,
    ]),
  );
}

describe('ThrottleLimit', () => {
  it('applies the override under every policy name', () => {
    // @Throttle targets one throttler by name. Since the active policy is decided
    // per request, pinning a single name would leave the route unlimited under the
    // others — which is how a 5/min login cap becomes 300/min once a session exists.
    const ours = decorate(ThrottleLimit(5) as MethodDecorator);
    const equivalent = decorate(
      Throttle(
        Object.fromEntries(
          THROTTLE_POLICIES.map((name) => [name, { limit: 5, ttl: 60_000 }]),
        ),
      ) as MethodDecorator,
    );

    expect(metadataOf(ours)).toEqual(metadataOf(equivalent));
  });

  it('covers more than a single-policy @Throttle would', () => {
    const ours = decorate(ThrottleLimit(5) as MethodDecorator);
    const singlePolicy = decorate(
      Throttle({ authenticated: { limit: 5, ttl: 60_000 } }) as MethodDecorator,
    );

    expect(metadataOf(ours)).not.toEqual(metadataOf(singlePolicy));
  });
});

describe('NoThrottle', () => {
  it('skips every policy', () => {
    const ours = decorate(NoThrottle() as MethodDecorator);
    const equivalent = decorate(
      SkipThrottle(
        Object.fromEntries(THROTTLE_POLICIES.map((name) => [name, true])),
      ) as MethodDecorator,
    );

    expect(metadataOf(ours)).toEqual(metadataOf(equivalent));
  });

  it('is not the same as a bare @SkipThrottle()', () => {
    // Bare @SkipThrottle() only skips a throttler literally named `default`, which
    // this app no longer defines. Using it on the Stripe webhook would have left
    // subscription-lifecycle events rate limited, with nothing to notice.
    const ours = decorate(NoThrottle() as MethodDecorator);
    const bare = decorate(SkipThrottle() as MethodDecorator);

    expect(metadataOf(ours)).not.toEqual(metadataOf(bare));
    expect(Object.keys(metadataOf(bare))).toHaveLength(1);
  });
});

describe('policy limits', () => {
  it('defines a limit for every policy', () => {
    for (const name of THROTTLE_POLICIES) {
      expect(THROTTLE_POLICY_LIMITS[name]).toEqual({
        limit: expect.any(Number),
        ttl: expect.any(Number),
      });
    }
  });

  it('gives authenticated callers more room than anonymous ones', () => {
    expect(THROTTLE_POLICY_LIMITS.authenticated.limit).toBeGreaterThan(
      THROTTLE_POLICY_LIMITS.public.limit,
    );
  });
});
