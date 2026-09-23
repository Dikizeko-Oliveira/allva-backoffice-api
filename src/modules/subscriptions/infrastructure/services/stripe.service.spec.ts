import { StripeService } from './stripe.service';

/**
 * Safety net for the Stripe money path, built **before** the Mercado Pago removal
 * touches it (PLAN.md Sprint 6 follow-up). `stripe.service.ts` sat at 2,9% coverage
 * while carrying every call that creates, reads or cancels a paid subscription.
 *
 * The client is resolved through a module-level accessor (`D-7`), so it is mocked
 * at the module boundary rather than injected. That is deliberate: the net was
 * built around the code **as it ran in production**, which is what made the
 * lazy-accessor refactor safe to do afterwards — these tests caught it, they did
 * not follow it.
 */

const stripeClientMock = {
  customers: { create: jest.fn(), update: jest.fn() },
  prices: { retrieve: jest.fn() },
  products: { retrieve: jest.fn() },
  subscriptions: {
    create: jest.fn(),
    retrieve: jest.fn(),
    update: jest.fn(),
  },
  invoices: { retrieve: jest.fn(), list: jest.fn() },
  paymentIntents: { retrieve: jest.fn() },
  paymentMethods: { attach: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
  setupIntents: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
};

jest.mock('./stripe.client', () => ({
  getStripeClient: () => stripeClientMock,
  isStripeConfigured: () => true,
  resetStripeClient: () => undefined,
}));

const stripeClient = stripeClientMock as unknown as Record<string, any>;

function buildService() {
  const service = new StripeService();

  for (const level of ['log', 'error', 'warn'] as const) {
    jest
      .spyOn((service as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return service;
}

/** A price that passes every validation gate. */
function validPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price_1',
    active: true,
    recurring: { interval: 'month' },
    unit_amount: 4990,
    currency: 'brl',
    product: { active: true },
    ...overrides,
  };
}

describe('StripeService', () => {
  const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  });

  describe('ensureStripeCustomer', () => {
    it('reuses an existing customer without calling Stripe', async () => {
      const service = buildService();

      await expect(
        service.ensureStripeCustomer({
          existingStripeCustomerId: 'cus_existing',
          email: 'ana@example.com',
          name: 'Ana',
        }),
      ).resolves.toEqual({ stripeCustomerId: 'cus_existing' });

      expect(stripeClient.customers.create).not.toHaveBeenCalled();
    });

    it('creates a customer carrying the account id as metadata', async () => {
      const service = buildService();
      stripeClient.customers.create.mockResolvedValue({ id: 'cus_new' });

      await expect(
        service.ensureStripeCustomer({
          email: 'ana@example.com',
          name: 'Ana',
          accountId: 'acc-1',
        }),
      ).resolves.toEqual({ stripeCustomerId: 'cus_new' });

      expect(stripeClient.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { accountId: 'acc-1' } }),
      );
    });

    it('omits metadata entirely when there is no account id', async () => {
      const service = buildService();
      stripeClient.customers.create.mockResolvedValue({ id: 'cus_new' });

      await service.ensureStripeCustomer({
        email: 'ana@example.com',
        name: 'Ana',
      });

      const [payload] = stripeClient.customers.create.mock.calls[0];
      expect(payload).not.toHaveProperty('metadata');
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.ensureStripeCustomer({ email: 'a@b.c', name: 'Ana' }),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });

    it('wraps a Stripe failure in a diagnosable error', async () => {
      const service = buildService();
      stripeClient.customers.create.mockRejectedValue(new Error('network'));

      await expect(
        service.ensureStripeCustomer({ email: 'a@b.c', name: 'Ana' }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_CUSTOMER_ENSURE_FAILED' },
      });
    });
  });

  /**
   * This chain is what stops a misconfigured price from creating a subscription
   * that bills the wrong amount — or nothing at all.
   */
  describe('validateStripePrice', () => {
    it('accepts an active recurring paid price', async () => {
      const service = buildService();
      stripeClient.prices.retrieve.mockResolvedValue(validPrice());

      await expect(
        service.validateStripePrice('price_1'),
      ).resolves.toBeUndefined();
    });

    it('expands the product so its active flag can be checked', async () => {
      const service = buildService();
      stripeClient.prices.retrieve.mockResolvedValue(validPrice());

      await service.validateStripePrice('price_1');

      expect(stripeClient.prices.retrieve).toHaveBeenCalledWith('price_1', {
        expand: ['product'],
      });
    });

    it.each([
      [
        'price cannot be retrieved',
        () => stripeClient.prices.retrieve.mockRejectedValue(new Error('404')),
        'STRIPE_PRICE_NOT_FOUND',
      ],
      [
        'price is inactive',
        () =>
          stripeClient.prices.retrieve.mockResolvedValue(
            validPrice({ active: false }),
          ),
        'STRIPE_PRICE_INACTIVE',
      ],
      [
        'price is one-off rather than recurring',
        () =>
          stripeClient.prices.retrieve.mockResolvedValue(
            validPrice({ recurring: null }),
          ),
        'STRIPE_PRICE_NOT_RECURRING',
      ],
      [
        'price amount is zero',
        () =>
          stripeClient.prices.retrieve.mockResolvedValue(
            validPrice({ unit_amount: 0 }),
          ),
        'STRIPE_PRICE_ZERO_AMOUNT',
      ],
      [
        'the product behind the price is archived',
        () =>
          stripeClient.prices.retrieve.mockResolvedValue(
            validPrice({ product: { active: false } }),
          ),
        'STRIPE_PRODUCT_INACTIVE',
      ],
    ])('rejects when the %s', async (_name, arrange, code) => {
      const service = buildService();
      arrange();

      await expect(
        service.validateStripePrice('price_1'),
      ).rejects.toMatchObject({ response: { code } });
    });

    it('tolerates a product returned as a bare id instead of an object', async () => {
      const service = buildService();
      stripeClient.prices.retrieve.mockResolvedValue(
        validPrice({ product: 'prod_123' }),
      );

      // Not expanded is not the same as inactive.
      await expect(
        service.validateStripePrice('price_1'),
      ).resolves.toBeUndefined();
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.validateStripePrice('price_1'),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });
  });

  /**
   * `latest_invoice` and the client secret arrive in several shapes depending on the
   * API version and what was expanded. Every branch here is a real Stripe response
   * shape the service already tries to handle.
   */
  describe('createStripeSubscription — client secret resolution', () => {
    const INPUT = {
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_1',
      internalSubscriptionId: 'sub-internal-1',
    };

    function subscriptionWith(latestInvoice: unknown) {
      return {
        id: 'sub_stripe_1',
        status: 'incomplete',
        current_period_end: 1800000000,
        latest_invoice: latestInvoice,
      };
    }

    it('reads the client secret from confirmation_secret (current API)', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith({
          id: 'in_1',
          confirmation_secret: { client_secret: 'pi_secret_current' },
        }),
      );

      const result = await service.createStripeSubscription(INPUT);

      expect(result.clientSecret).toBe('pi_secret_current');
      expect(result.externalSubscriptionId).toBe('sub_stripe_1');
      expect(result.status).toBe('INCOMPLETE');
    });

    it('falls back to an expanded payment_intent (pre-clover API)', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith({
          id: 'in_1',
          payment_intent: { client_secret: 'pi_secret_legacy' },
        }),
      );

      const result = await service.createStripeSubscription(INPUT);

      expect(result.clientSecret).toBe('pi_secret_legacy');
    });

    it('retrieves the payment intent when it arrives as a bare id', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith({ id: 'in_1', payment_intent: 'pi_123' }),
      );
      stripeClient.paymentIntents.retrieve.mockResolvedValue({
        client_secret: 'pi_secret_fetched',
      });

      const result = await service.createStripeSubscription(INPUT);

      expect(stripeClient.paymentIntents.retrieve).toHaveBeenCalledWith(
        'pi_123',
      );
      expect(result.clientSecret).toBe('pi_secret_fetched');
    });

    it('retrieves the invoice when neither secret shape was expanded', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith({ id: 'in_1' }),
      );
      stripeClient.invoices.retrieve.mockResolvedValue({
        id: 'in_1',
        confirmation_secret: { client_secret: 'pi_secret_retrieved' },
      });

      const result = await service.createStripeSubscription(INPUT);

      expect(stripeClient.invoices.retrieve).toHaveBeenCalledWith('in_1', {
        expand: ['confirmation_secret', 'payment_intent'],
      });
      expect(result.clientSecret).toBe('pi_secret_retrieved');
    });

    it('handles latest_invoice arriving as a bare id', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith('in_bare'),
      );
      stripeClient.invoices.retrieve.mockResolvedValue({
        id: 'in_bare',
        confirmation_secret: { client_secret: 'pi_secret_from_bare' },
      });

      const result = await service.createStripeSubscription(INPUT);

      expect(result.clientSecret).toBe('pi_secret_from_bare');
    });

    it('links the internal subscription id through metadata', async () => {
      const service = buildService();
      stripeClient.subscriptions.create.mockResolvedValue(
        subscriptionWith({
          id: 'in_1',
          confirmation_secret: { client_secret: 's' },
        }),
      );

      await service.createStripeSubscription(INPUT);

      expect(stripeClient.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { internalSubscriptionId: 'sub-internal-1' },
          payment_behavior: 'default_incomplete',
        }),
      );
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.createStripeSubscription(INPUT),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });
  });

  describe('cancelSubscription', () => {
    // The M-3 path: cancel at period end, never immediately — the customer paid
    // for the term they are in.
    it('sets cancel_at_period_end rather than deleting', async () => {
      const service = buildService();
      stripeClient.subscriptions.update.mockResolvedValue({});

      await service.cancelSubscription({ externalRef: 'sub_stripe_1' });

      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_stripe_1',
        { cancel_at_period_end: true },
      );
    });

    it('refuses without an external reference instead of cancelling nothing quietly', async () => {
      const service = buildService();

      await expect(
        service.cancelSubscription({ externalRef: '' }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_SUBSCRIPTION_ID_REQUIRED' },
      });
      expect(stripeClient.subscriptions.update).not.toHaveBeenCalled();
    });
  });

  /**
   * The plan-change primitive behind `POST /billing/subscription/change` after the
   * Stripe migration. Product decision encoded here: upgrade charges the prorated
   * difference now, downgrade takes effect at the next invoice.
   */
  describe('changeSubscriptionPlan', () => {
    /** `null` means "subscription with no items" — `undefined` would hit the default. */
    function arrangeSubscription(itemId: string | null = 'si_1') {
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_1',
        items: { data: itemId ? [{ id: itemId }] : [] },
      });
      stripeClient.subscriptions.update.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        current_period_end: 1800000000,
      });
    }

    it('updates the existing item instead of adding a second one', async () => {
      const service = buildService();
      arrangeSubscription('si_existing');

      await service.changeSubscriptionPlan({
        externalRef: 'sub_1',
        newStripePriceId: 'price_pro',
        prorate: true,
      });

      // Passing a price without the item id would ADD an item and bill both plans.
      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({
          items: [{ id: 'si_existing', price: 'price_pro' }],
        }),
      );
    });

    it('invoices the difference immediately on an upgrade', async () => {
      const service = buildService();
      arrangeSubscription();

      await service.changeSubscriptionPlan({
        externalRef: 'sub_1',
        newStripePriceId: 'price_pro',
        prorate: true,
      });

      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ proration_behavior: 'always_invoice' }),
      );
    });

    it('neither charges nor credits on a downgrade', async () => {
      const service = buildService();
      arrangeSubscription();

      await service.changeSubscriptionPlan({
        externalRef: 'sub_1',
        newStripePriceId: 'price_starter',
        prorate: false,
      });

      // The cheaper price applies from the next invoice; the customer already paid
      // for the current period.
      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ proration_behavior: 'none' }),
      );
    });

    it('keeps the subscription active when the prorated charge needs SCA', async () => {
      const service = buildService();
      arrangeSubscription();

      await service.changeSubscriptionPlan({
        externalRef: 'sub_1',
        newStripePriceId: 'price_pro',
        prorate: true,
      });

      // `pending_if_incomplete` avoids dropping to `incomplete` and revoking access
      // mid-period over a 3DS challenge.
      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ payment_behavior: 'pending_if_incomplete' }),
      );
    });

    it('returns the normalised status and period end', async () => {
      const service = buildService();
      arrangeSubscription();

      await expect(
        service.changeSubscriptionPlan({
          externalRef: 'sub_1',
          newStripePriceId: 'price_pro',
          prorate: true,
        }),
      ).resolves.toEqual({
        status: 'ACTIVE',
        currentPeriodEnd: new Date(1800000000 * 1000),
      });
    });

    it('refuses a subscription with no billable item', async () => {
      const service = buildService();
      arrangeSubscription(null);

      await expect(
        service.changeSubscriptionPlan({
          externalRef: 'sub_1',
          newStripePriceId: 'price_pro',
          prorate: true,
        }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_SUBSCRIPTION_ITEM_NOT_FOUND' },
      });
      expect(stripeClient.subscriptions.update).not.toHaveBeenCalled();
    });

    it('refuses without an external reference', async () => {
      const service = buildService();

      await expect(
        service.changeSubscriptionPlan({
          externalRef: '',
          newStripePriceId: 'price_pro',
          prorate: true,
        }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_SUBSCRIPTION_ID_REQUIRED' },
      });
    });

    it('wraps a Stripe failure in a diagnosable error', async () => {
      const service = buildService();
      arrangeSubscription();
      stripeClient.subscriptions.update.mockRejectedValue(
        new Error('card declined'),
      );

      await expect(
        service.changeSubscriptionPlan({
          externalRef: 'sub_1',
          newStripePriceId: 'price_pro',
          prorate: true,
        }),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_PLAN_CHANGE_FAILED' },
      });
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.changeSubscriptionPlan({
          externalRef: 'sub_1',
          newStripePriceId: 'price_pro',
          prorate: true,
        }),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });
  });

  /**
   * Backs `PUT /billing/payment-method`. Three writes have to land, and skipping any
   * one leaves the customer charged on the old card.
   */
  describe('setSubscriptionPaymentMethod', () => {
    const INPUT = {
      externalRef: 'sub_1',
      stripeCustomerId: 'cus_1',
      paymentMethodId: 'pm_new',
    };

    function arrangeAttach(
      card: Record<string, unknown> | null = {
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: 2030,
      },
    ) {
      stripeClient.paymentMethods.attach.mockResolvedValue({ card });
      stripeClient.subscriptions.update.mockResolvedValue({});
      stripeClient.customers.update.mockResolvedValue({});
    }

    it('attaches, sets the subscription default, and sets the customer default', async () => {
      const service = buildService();
      arrangeAttach();

      await service.setSubscriptionPaymentMethod(INPUT);

      expect(stripeClient.paymentMethods.attach).toHaveBeenCalledWith(
        'pm_new',
        {
          customer: 'cus_1',
        },
      );
      // This is the one renewals actually use.
      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_1',
        expect.objectContaining({ default_payment_method: 'pm_new' }),
      );
      // And this one covers future subscriptions and one-off invoices.
      expect(stripeClient.customers.update).toHaveBeenCalledWith(
        'cus_1',
        expect.objectContaining({
          invoice_settings: { default_payment_method: 'pm_new' },
        }),
      );
    });

    it('returns the card details Stripe holds', async () => {
      const service = buildService();
      arrangeAttach();

      await expect(
        service.setSubscriptionPaymentMethod(INPUT),
      ).resolves.toEqual({
        externalCardId: 'pm_new',
        brand: 'visa',
        lastFourDigits: '4242',
        expirationMonth: 12,
        expirationYear: 2030,
        paymentMethod: 'CREDIT_CARD',
      });
    });

    // Attaching a method that is already attached is an error at Stripe; resending
    // the same card must still succeed rather than failing the whole change.
    it('tolerates a payment method that is already attached', async () => {
      const service = buildService();
      stripeClient.paymentMethods.attach.mockRejectedValue(
        new Error('already attached'),
      );
      stripeClient.paymentMethods.retrieve.mockResolvedValue({
        card: {
          brand: 'mastercard',
          last4: '1111',
          exp_month: 1,
          exp_year: 2031,
        },
      });
      stripeClient.subscriptions.update.mockResolvedValue({});
      stripeClient.customers.update.mockResolvedValue({});

      await expect(
        service.setSubscriptionPaymentMethod(INPUT),
      ).resolves.toMatchObject({ lastFourDigits: '1111' });

      expect(stripeClient.subscriptions.update).toHaveBeenCalled();
    });

    it('refuses a payment method that is not a card', async () => {
      const service = buildService();
      arrangeAttach(null);

      await expect(
        service.setSubscriptionPaymentMethod(INPUT),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_PAYMENT_METHOD_NOT_A_CARD' },
      });
      expect(stripeClient.subscriptions.update).not.toHaveBeenCalled();
    });

    it('wraps a Stripe failure in a diagnosable error', async () => {
      const service = buildService();
      arrangeAttach();
      stripeClient.subscriptions.update.mockRejectedValue(
        new Error('subscription not found'),
      );

      await expect(
        service.setSubscriptionPaymentMethod(INPUT),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_PAYMENT_METHOD_UPDATE_FAILED' },
      });
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.setSubscriptionPaymentMethod(INPUT),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });
  });

  /**
   * Backs the billing screen's "which card am I charged on?".
   *
   * The card used at checkout is confirmed client-side with Stripe.js and never
   * reaches this API, so reading it back from Stripe is the only way to know it.
   */
  describe('getSubscriptionDefaultCard', () => {
    const CARD = {
      brand: 'visa',
      last4: '4242',
      exp_month: 11,
      exp_year: 2029,
      funding: 'credit',
    };

    it('reads the card off the subscription default', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
        default_payment_method: { id: 'pm_1', card: CARD },
      });

      await expect(
        service.getSubscriptionDefaultCard('sub_1'),
      ).resolves.toEqual({
        externalCardId: 'pm_1',
        externalCustomerId: 'cus_1',
        brand: 'visa',
        lastFourDigits: '4242',
        expirationMonth: 11,
        expirationYear: 2029,
        paymentMethod: 'CREDIT_CARD',
      });
    });

    it('retrieves the payment method when it arrives as a bare id', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
        default_payment_method: 'pm_1',
      });
      stripeClient.paymentMethods.retrieve.mockResolvedValue({
        id: 'pm_1',
        card: CARD,
      });

      const details = await service.getSubscriptionDefaultCard('sub_1');

      expect(stripeClient.paymentMethods.retrieve).toHaveBeenCalledWith('pm_1');
      expect(details?.externalCardId).toBe('pm_1');
    });

    it('marks a debit card as such', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
        default_payment_method: {
          id: 'pm_1',
          card: { ...CARD, funding: 'debit' },
        },
      });

      const details = await service.getSubscriptionDefaultCard('sub_1');

      expect(details?.paymentMethod).toBe('DEBIT_CARD');
    });

    // What an older subscription leaves behind: the card is the customer's default
    // even though Stripe never wrote it onto the subscription.
    it('falls back to the customer default when the subscription has none', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        default_payment_method: null,
        customer: {
          id: 'cus_1',
          invoice_settings: {
            default_payment_method: { id: 'pm_customer', card: CARD },
          },
        },
      });

      const details = await service.getSubscriptionDefaultCard('sub_1');

      expect(details?.externalCardId).toBe('pm_customer');
      expect(details?.externalCustomerId).toBe('cus_1');
    });

    it('falls back to the customer card when there is exactly one', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
      });
      stripeClient.paymentMethods.list.mockResolvedValue({
        data: [{ id: 'pm_only', card: CARD }],
      });

      const details = await service.getSubscriptionDefaultCard('sub_1');

      expect(details?.externalCardId).toBe('pm_only');
    });

    // With two cards and no default, any pick is a guess — and a guessed card shown
    // as "the card you are charged on" is worse than showing none.
    it('refuses to guess when the customer has more than one card', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
      });
      stripeClient.paymentMethods.list.mockResolvedValue({
        data: [
          { id: 'pm_a', card: CARD },
          { id: 'pm_b', card: CARD },
        ],
      });

      await expect(
        service.getSubscriptionDefaultCard('sub_1'),
      ).resolves.toBeNull();
    });

    it('returns null when no card resolves anywhere', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
      });
      stripeClient.paymentMethods.list.mockResolvedValue({ data: [] });

      await expect(
        service.getSubscriptionDefaultCard('sub_1'),
      ).resolves.toBeNull();
    });

    it('ignores a default payment method that is not a card', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        customer: 'cus_1',
        default_payment_method: { id: 'pm_boleto', card: null },
      });
      stripeClient.paymentMethods.list.mockResolvedValue({ data: [] });

      await expect(
        service.getSubscriptionDefaultCard('sub_1'),
      ).resolves.toBeNull();
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.getSubscriptionDefaultCard('sub_1'),
      ).rejects.toMatchObject({
        response: { code: 'STRIPE_NOT_CONFIGURED' },
      });
    });
  });

  describe('mapStripeSubscriptionStatus', () => {
    it.each([
      ['active', 'ACTIVE'],
      ['trialing', 'TRIALING'],
      ['past_due', 'PAST_DUE'],
      ['canceled', 'CANCELED'],
      ['unpaid', 'UNPAID'],
      ['incomplete', 'INCOMPLETE'],
      ['incomplete_expired', 'EXPIRED'],
      ['paused', 'PAUSED'],
    ])('maps %s to %s', (stripeStatus, expected) => {
      expect(buildService().mapStripeSubscriptionStatus(stripeStatus)).toBe(
        expected,
      );
    });

    // A status Stripe adds later must not be read as ACTIVE — granting access on an
    // unknown state is the dangerous direction to fail in.
    it('treats an unknown status as PENDING_PAYMENT', () => {
      expect(
        buildService().mapStripeSubscriptionStatus('some_future_status'),
      ).toBe('PENDING_PAYMENT');
    });
  });

  describe('mapStripeInvoiceStatus', () => {
    it.each([
      ['paid', 'PAID'],
      ['open', 'PENDING'],
      ['draft', 'PENDING'],
      ['uncollectible', 'FAILED'],
      ['void', 'FAILED'],
    ])('maps %s to %s', (stripeStatus, expected) => {
      expect(buildService().mapStripeInvoiceStatus(stripeStatus)).toBe(
        expected,
      );
    });

    it('maps an absent status to PENDING', () => {
      expect(buildService().mapStripeInvoiceStatus(undefined)).toBe('PENDING');
    });
  });

  describe('getStripeSubscription', () => {
    it('normalises timestamps from seconds to Date', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        current_period_end: 1800000000,
        canceled_at: 1700000000,
      });

      const result = await service.getStripeSubscription('sub_1');

      expect(result.status).toBe('ACTIVE');
      expect(result.nextBillingAt).toEqual(new Date(1800000000 * 1000));
      expect(result.canceledAt).toEqual(new Date(1700000000 * 1000));
    });

    it('reads current_period_end from the subscription item (current API shape)', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        billing_cycle_anchor: 1750000000,
        items: { data: [{ current_period_end: 1800000000 }] },
      });

      const result = await service.getStripeSubscription('sub_1');

      // O item ganha do topo, e o `billing_cycle_anchor` não entra na conta.
      expect(result.nextBillingAt).toEqual(new Date(1800000000 * 1000));
    });

    it('does NOT fall back to billing_cycle_anchor when no period end is available', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'trialing',
        billing_cycle_anchor: 1750000000,
      });

      const result = await service.getStripeSubscription('sub_1');

      /**
       * O `billing_cycle_anchor` é o **início** do ciclo. Devolvê-lo como fim
       * gravava uma "próxima cobrança" no passado, e era isso que fazia todo
       * downgrade agendado vencer no ato. Sem período conhecido, a resposta
       * honesta é a ausência.
       */
      expect(result.nextBillingAt).toBeUndefined();
    });

    it('leaves canceledAt undefined for a subscription that was never cancelled', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        id: 'sub_1',
        status: 'active',
        current_period_end: 1800000000,
        canceled_at: null,
      });

      const result = await service.getStripeSubscription('sub_1');

      expect(result.canceledAt).toBeUndefined();
    });
  });

  describe('createSetupIntent', () => {
    it('returns the client secret for the given customer', async () => {
      const service = buildService();
      stripeClient.setupIntents.create.mockResolvedValue({
        client_secret: 'seti_secret',
      });

      await expect(service.createSetupIntent('cus_1')).resolves.toEqual({
        clientSecret: 'seti_secret',
      });
    });

    it('fails loudly when Stripe returns no client secret', async () => {
      const service = buildService();
      stripeClient.setupIntents.create.mockResolvedValue({});

      await expect(service.createSetupIntent('cus_1')).rejects.toThrow();
    });
  });

  describe('getInvoicePdfUrl', () => {
    it('returns the hosted PDF url', async () => {
      const service = buildService();
      stripeClient.invoices.retrieve.mockResolvedValue({
        invoice_pdf: 'https://stripe.com/invoice.pdf',
      });

      await expect(service.getInvoicePdfUrl('in_1')).resolves.toBe(
        'https://stripe.com/invoice.pdf',
      );
    });

    it('returns null for an invoice with no PDF yet', async () => {
      const service = buildService();
      stripeClient.invoices.retrieve.mockResolvedValue({});

      await expect(service.getInvoicePdfUrl('in_1')).resolves.toBeNull();
    });
  });

  /**
   * Reconciliation (Sprint 1, A-1) uses this to rebuild billing history when an
   * `invoice.paid` webhook was lost, so the normalisation has to be exact — these
   * values become Invoice and Payment rows.
   */
  describe('listSubscriptionInvoices', () => {
    it('converts amounts from cents and timestamps from seconds', async () => {
      const service = buildService();
      stripeClient.invoices.list.mockResolvedValue({
        data: [
          {
            id: 'in_1',
            status: 'paid',
            amount_paid: 4990,
            currency: 'brl',
            period_start: 1700000000,
            period_end: 1702592000,
            charge: 'ch_1',
            status_transitions: { paid_at: 1700000500 },
          },
        ],
      });

      const [invoice] = await service.listSubscriptionInvoices('sub_1');

      expect(invoice).toEqual({
        externalInvoiceId: 'in_1',
        externalPaymentId: 'ch_1',
        status: 'PAID',
        amount: 49.9,
        currency: 'BRL',
        periodStart: new Date(1700000000 * 1000),
        periodEnd: new Date(1702592000 * 1000),
        paidAt: new Date(1700000500 * 1000),
      });
    });

    it('reads the charge id when it arrives expanded', async () => {
      const service = buildService();
      stripeClient.invoices.list.mockResolvedValue({
        data: [{ id: 'in_1', status: 'paid', charge: { id: 'ch_expanded' } }],
      });

      const [invoice] = await service.listSubscriptionInvoices('sub_1');

      expect(invoice.externalPaymentId).toBe('ch_expanded');
    });

    it('falls back to amount_due for an invoice that was never paid', async () => {
      const service = buildService();
      stripeClient.invoices.list.mockResolvedValue({
        data: [{ id: 'in_1', status: 'open', amount_due: 1000 }],
      });

      const [invoice] = await service.listSubscriptionInvoices('sub_1');

      expect(invoice.amount).toBe(10);
      expect(invoice.status).toBe('PENDING');
      expect(invoice.paidAt).toBeUndefined();
    });

    it('returns an empty list rather than throwing when there are no invoices', async () => {
      const service = buildService();
      stripeClient.invoices.list.mockResolvedValue({});

      await expect(service.listSubscriptionInvoices('sub_1')).resolves.toEqual(
        [],
      );
    });

    it('asks Stripe for the requested page size', async () => {
      const service = buildService();
      stripeClient.invoices.list.mockResolvedValue({ data: [] });

      await service.listSubscriptionInvoices('sub_1', 5);

      expect(stripeClient.invoices.list).toHaveBeenCalledWith(
        expect.objectContaining({ subscription: 'sub_1', limit: 5 }),
      );
    });
  });

  describe('createCheckout', () => {
    const INPUT = {
      accountId: 'acc-1',
      planId: 'plan-pro',
      stripePriceId: 'price_1',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/cancel',
    };

    it('creates a subscription-mode session carrying the account id', async () => {
      const service = buildService();
      stripeClient.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/x',
      });

      await expect(service.createCheckout(INPUT)).resolves.toEqual({
        checkoutUrl: 'https://checkout.stripe.com/x',
      });

      expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          metadata: { accountId: 'acc-1', planId: 'plan-pro' },
          line_items: [{ price: 'price_1', quantity: 1 }],
        }),
      );
    });

    /**
     * `invoice.paid` - o evento que de fato ativa o plano - carrega a
     * subscription, nunca a sessão. Sem o metadata carimbado também nela, o
     * pagamento chega ao webhook sem dono e a conta segue sem plano depois de
     * pagar.
     */
    it('also stamps the identity on the subscription itself', async () => {
      const service = buildService();
      stripeClient.checkout.sessions.create.mockResolvedValue({ url: 'u' });

      await service.createCheckout(INPUT);

      expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: {
            metadata: { accountId: 'acc-1', planId: 'plan-pro' },
          },
        }),
      );
    });

    it('attaches an existing customer when there is one', async () => {
      const service = buildService();
      stripeClient.checkout.sessions.create.mockResolvedValue({ url: 'u' });

      await service.createCheckout({ ...INPUT, stripeCustomerId: 'cus_1' });

      expect(stripeClient.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ customer: 'cus_1' }),
      );
    });

    it('omits the customer key entirely for a first-time buyer', async () => {
      const service = buildService();
      stripeClient.checkout.sessions.create.mockResolvedValue({ url: 'u' });

      await service.createCheckout(INPUT);

      const [payload] = stripeClient.checkout.sessions.create.mock.calls[0];
      expect(payload).not.toHaveProperty('customer');
    });

    it('fails when Stripe returns a session without a url', async () => {
      const service = buildService();
      stripeClient.checkout.sessions.create.mockResolvedValue({});

      await expect(service.createCheckout(INPUT)).rejects.toMatchObject({
        response: { code: 'STRIPE_CHECKOUT_FAILED' },
      });
    });
  });

  /** Backs `GET /subscriptions/client-secret` — resuming an interrupted payment. */
  describe('getClientSecretForIncompleteSubscription', () => {
    it('reads the secret from an expanded invoice', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        latest_invoice: {
          id: 'in_1',
          confirmation_secret: { client_secret: 'pi_secret' },
        },
      });

      await expect(
        service.getClientSecretForIncompleteSubscription('sub_1'),
      ).resolves.toEqual({ clientSecret: 'pi_secret' });
    });

    it('retrieves the invoice when it arrives as a bare id', async () => {
      const service = buildService();
      stripeClient.subscriptions.retrieve.mockResolvedValue({
        latest_invoice: 'in_bare',
      });
      stripeClient.invoices.retrieve.mockResolvedValue({
        confirmation_secret: { client_secret: 'pi_secret_fetched' },
      });

      await expect(
        service.getClientSecretForIncompleteSubscription('sub_1'),
      ).resolves.toEqual({ clientSecret: 'pi_secret_fetched' });
    });

    it('refuses to run when Stripe is not configured', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      const service = buildService();

      await expect(
        service.getClientSecretForIncompleteSubscription('sub_1'),
      ).rejects.toMatchObject({ response: { code: 'STRIPE_NOT_CONFIGURED' } });
    });
  });
});
