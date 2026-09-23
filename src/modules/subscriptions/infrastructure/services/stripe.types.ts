// Stripe v22 (dahlia API) moved to proper ESM TypeScript types. With CommonJS
// moduleResolution the default import resolves to `StripeConstructor`, whose
// declared namespace no longer re-exports Event, Price, Product, Subscription.
// We derive these types from the Stripe client instance instead.
import type { getStripeClient } from './stripe.client';

type StripeClient = ReturnType<typeof getStripeClient>;

export type StripeEvent = ReturnType<
  StripeClient['webhooks']['constructEvent']
>;
export type StripePrice = Awaited<
  ReturnType<StripeClient['prices']['retrieve']>
>;
export type StripeProduct = Awaited<
  ReturnType<StripeClient['products']['retrieve']>
>;
export type StripeSubscription = Awaited<
  ReturnType<StripeClient['subscriptions']['retrieve']>
>;

/**
 * Fields the service reads off a Stripe Invoice that the clover API's generated
 * types no longer declare — either they moved (`payment_intent` →
 * `confirmation_secret`) or they were dropped from the type while still being
 * sent in the response.
 *
 * These exist so the read path can be *narrow* rather than `any`. The service
 * used to start from `const subRaw = sub as any`, and that single cast
 * propagated `any` through every downstream access — around fifty of them, each
 * one a place where a typo in a Stripe field name would have compiled fine and
 * returned `undefined` at runtime.
 *
 * Deliberately all-optional: this describes what Stripe *may* send, and every
 * consumer already branches on presence.
 */
export type RawStripeInvoice = {
  id?: string;
  amount_due?: number;
  amount_paid?: number;
  charge?: string | { id?: string } | null;
  collection_method?: string;
  confirmation_secret?: string | { client_secret?: string } | null;
  currency?: string;
  paid?: boolean;
  payment_intent?: string | { id?: string; client_secret?: string } | null;
  period_start?: number;
  period_end?: number;
  status?: string;
  status_transitions?: { paid_at?: number } | null;
  invoice_pdf?: string | null;
  hosted_invoice_url?: string | null;
};

/** Same idea for Subscription: `current_period_end` is still sent but no longer typed. */
export type RawStripeSubscription = {
  id?: string;
  status?: string;
  current_period_end?: number;
  billing_cycle_anchor?: number;
  canceled_at?: number;
  latest_invoice?: string | RawStripeInvoice | null;
  default_payment_method?: string | RawStripePaymentMethod | null;
  customer?:
    | string
    | {
        id?: string;
        invoice_settings?: {
          default_payment_method?: string | RawStripePaymentMethod | null;
        } | null;
      }
    | null;
};

/**
 * Card fields read off a Stripe PaymentMethod. Same reasoning as the two types
 * above: narrow instead of `any`, and all-optional because Stripe only sends
 * `card` when the payment method actually is one.
 */
export type RawStripePaymentMethod = {
  id?: string;
  customer?: string | { id?: string } | null;
  card?: {
    brand?: string;
    last4?: string;
    exp_month?: number;
    exp_year?: number;
    funding?: string;
  } | null;
};

/** A payment method as Stripe may return it: expanded, a bare id, or absent. */
export type StripePaymentMethodRef =
  | string
  | RawStripePaymentMethod
  | null
  | undefined;
