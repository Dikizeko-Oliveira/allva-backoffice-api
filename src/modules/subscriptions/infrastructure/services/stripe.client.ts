import Stripe from 'stripe';

/**
 * `STRIPE_SECRET_KEY` is optional (see `docs/env-secrets.md`), so this module must
 * not throw at import time when it is absent — a module-level throw would take the
 * whole boot down over an optional credential, which is exactly what P-6 forbids.
 *
 * ⚠️ Do NOT "simplify" the fallback to `?? ''` or drop it. Measured behaviour of the
 * Stripe SDK:
 *
 *   new Stripe(undefined)     -> throws "Neither apiKey nor config.authenticator provided"
 *   new Stripe('')            -> throws (empty string is falsy to the SDK)
 *   new Stripe('any-string')  -> constructs fine, fails later at request time
 *
 * Only a non-empty placeholder is safe here. With it, construction succeeds and an
 * unconfigured Stripe fails per-request with an auth error, while
 * `ConfigReadinessService` reports the missing key once at boot.
 */
const UNCONFIGURED_PLACEHOLDER = 'sk_stripe_not_configured';

const API_VERSION = '2026-04-22.dahlia';

/** The default export is a constructor + namespace, not a type. */
type StripeClient = InstanceType<typeof Stripe>;

let cached: StripeClient | null = null;

function secretKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY?.trim() || undefined;
}

/** Whether a real credential is present — lets a caller tell "Stripe is not set
 *  up here" apart from "Stripe rejected the request". */
export function isStripeConfigured(): boolean {
  return Boolean(secretKey());
}

/**
 * Lazily-constructed, memoised Stripe client (PLAN.md D-7).
 *
 * The previous `export const stripeClient = new Stripe(...)` ran at *import*
 * time: the SDK was constructed, and `process.env` read, before Nest had even
 * built the module graph. Deferring to first use matches the lazy pattern
 * `OpenAIClient` and `AnthropicClient` already follow.
 *
 * The placeholder behaviour above is deliberately **unchanged**. It is tempting
 * to throw here when the key is missing, like `OpenAIClient` does, but Stripe is
 * not symmetric with it: `webhooks.constructEvent` is pure crypto and must keep
 * working without an API key. Callers that need to know whether billing is set
 * up ask `isStripeConfigured()`.
 */
export function getStripeClient(): StripeClient {
  if (!cached) {
    cached = new Stripe(secretKey() ?? UNCONFIGURED_PLACEHOLDER, {
      apiVersion: API_VERSION,
    });
  }

  return cached;
}

/** Test seam — the memoised instance would otherwise leak across cases. */
export function resetStripeClient(): void {
  cached = null;
}
