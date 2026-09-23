import {
  getStripeClient,
  isStripeConfigured,
  resetStripeClient,
} from './stripe.client';

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

function withKey(value: string | undefined) {
  if (value === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = value;

  resetStripeClient();
}

describe('stripe.client', () => {
  afterEach(() => {
    withKey(ORIGINAL_KEY);
  });

  describe('isStripeConfigured', () => {
    it('is false when the key is absent, empty or blank', () => {
      for (const value of [undefined, '', '   ']) {
        withKey(value);
        expect(isStripeConfigured()).toBe(false);
      }
    });

    it('is true for a real key', () => {
      withKey('sk_test_123');
      expect(isStripeConfigured()).toBe(true);
    });
  });

  describe('getStripeClient', () => {
    /**
     * The D-7 fix. The client used to be built by a module-level
     * `new Stripe(...)`, which ran at *import* time — the SDK was constructed and
     * `process.env` read before Nest had a module graph.
     */
    it('constructs on first use and memoises afterwards', () => {
      withKey('sk_test_123');

      expect(getStripeClient()).toBe(getStripeClient());
    });

    it('picks up a key set after import', () => {
      withKey(undefined);
      const unconfigured = getStripeClient();

      withKey('sk_test_later');

      expect(getStripeClient()).not.toBe(unconfigured);
    });

    /**
     * The placeholder is load-bearing and deliberately *not* replaced by a throw
     * (which is what `OpenAIClient` does when its key is missing). Measured SDK
     * behaviour: `new Stripe(undefined)` and `new Stripe('')` both throw, so an
     * unconfigured deploy would fail at import. And `webhooks.constructEvent` is
     * pure crypto — it must keep working without an API key.
     */
    it('still returns a usable client when unconfigured', () => {
      withKey(undefined);

      const client = getStripeClient();

      expect(client).toBeDefined();
      expect(typeof client.webhooks.constructEvent).toBe('function');
    });

    it('treats a blank key as unconfigured rather than passing it to the SDK', () => {
      withKey('   ');

      // `new Stripe('   ')` would construct with a nonsense credential; the
      // placeholder path is the one that must be taken.
      expect(isStripeConfigured()).toBe(false);
      expect(getStripeClient()).toBeDefined();
    });
  });
});
