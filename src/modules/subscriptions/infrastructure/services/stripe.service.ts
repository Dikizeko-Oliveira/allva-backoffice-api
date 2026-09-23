import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getStripeClient } from './stripe.client';
import type {
  RawStripeInvoice,
  RawStripePaymentMethod,
  RawStripeSubscription,
  StripePaymentMethodRef,
} from './stripe.types';
import type {
  StripePrice,
  StripeProduct,
  StripeSubscription,
} from './stripe.types';

/** The card Stripe actually charges, normalized to what `BillingCard` stores. */
export type StripeCardDetails = {
  externalCardId: string;
  externalCustomerId: string;
  brand?: string;
  lastFourDigits: string;
  expirationMonth: number;
  expirationYear: number;
  paymentMethod?: 'CREDIT_CARD' | 'DEBIT_CARD';
};

export type StripeNormalizedInvoice = {
  externalInvoiceId: string;
  externalPaymentId?: string;
  status: 'PAID' | 'PENDING' | 'FAILED';
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  paidAt?: Date;
};

type StripeSubscriptionStatus =
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'TRIALING'
  | 'PAST_DUE'
  | 'UNPAID'
  | 'INCOMPLETE'
  | 'EXPIRED'
  | 'CANCELED'
  | 'PAUSED';

/**
 * O fim do período pago de uma assinatura Stripe.
 *
 * ## Por que não é só ler um campo
 *
 * A Stripe moveu `current_period_end` do topo da assinatura para **cada item**
 * nas versões recentes da API. O código lia o campo do topo e, quando ele vinha
 * ausente, caía em `billing_cycle_anchor` — que é o **início** do ciclo, não o
 * fim. Um início está, por definição, no passado.
 *
 * O estrago não era cosmético. `ChangeSubscriptionUseCase` agenda o downgrade
 * para esta data, e `applyScheduledDowngradeIfDue()` aplica a queda assim que a
 * data chega: com um instante passado no lugar do fim do período, **todo
 * downgrade valia imediatamente**, no primeiro `customer.subscription.updated`
 * que a Stripe entregasse. O cliente pedia para cair de plano no mês seguinte e
 * perdia na hora o Profissional que já tinha pago — o oposto exato da regra que
 * o caso de uso documenta. O mesmo valor alimentava `nextBillingAt`, então a
 * data de "próxima cobrança" também mostrava o passado.
 *
 * A ordem aqui é a da API atual primeiro (item), topo como compatibilidade com
 * versões antigas, e **nada** como terceira opção: sem período conhecido, quem
 * chama decide o que fazer com a ausência. Adivinhar foi o que causou isto.
 */
function readCurrentPeriodEnd(subscription: unknown): Date | undefined {
  const raw = subscription as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  } | null;

  const seconds =
    raw?.items?.data?.[0]?.current_period_end ?? raw?.current_period_end;

  return typeof seconds === 'number' ? new Date(seconds * 1000) : undefined;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  async ensureStripeCustomer(input: {
    existingStripeCustomerId?: string;
    email: string;
    name: string;
    accountId?: string;
  }): Promise<{ stripeCustomerId: string }> {
    if (input.existingStripeCustomerId) {
      return { stripeCustomerId: input.existingStripeCustomerId };
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    try {
      const customer = await getStripeClient().customers.create({
        email: input.email,
        name: input.name,
        ...(input.accountId
          ? { metadata: { accountId: input.accountId } }
          : {}),
      });

      return { stripeCustomerId: customer.id };
    } catch (error) {
      this.logger.error('Stripe customer ensure failed', error);
      throw new InternalServerErrorException({
        code: 'STRIPE_CUSTOMER_ENSURE_FAILED',
        message: 'Unable to ensure Stripe customer',
      });
    }
  }

  async validateStripePrice(stripePriceId: string): Promise<void> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    let price: StripePrice;

    try {
      price = await getStripeClient().prices.retrieve(stripePriceId, {
        expand: ['product'],
      });
    } catch (error) {
      this.logger.error(
        `Failed to retrieve Stripe price ${stripePriceId}`,
        error instanceof Error ? error.message : error,
      );
      throw new UnprocessableEntityException({
        code: 'STRIPE_PRICE_NOT_FOUND',
        message: `Stripe price ${stripePriceId} not found or inaccessible`,
      });
    }

    const unitAmount = price.unit_amount ?? 0;
    const isRecurring = !!price.recurring;
    const isActive = price.active;

    this.logger.log(
      `[Stripe price validation] id=${stripePriceId} active=${isActive} ` +
        `recurring=${isRecurring} unit_amount=${unitAmount} currency=${price.currency}`,
    );

    if (!isActive) {
      throw new UnprocessableEntityException({
        code: 'STRIPE_PRICE_INACTIVE',
        message: 'Invalid Stripe price: price is not active',
      });
    }

    if (!isRecurring) {
      throw new UnprocessableEntityException({
        code: 'STRIPE_PRICE_NOT_RECURRING',
        message:
          'Invalid Stripe price: expected an active recurring paid price',
      });
    }

    if (unitAmount <= 0) {
      throw new UnprocessableEntityException({
        code: 'STRIPE_PRICE_ZERO_AMOUNT',
        message: 'Invalid Stripe price: unit_amount must be greater than zero',
      });
    }

    const product = price.product;
    if (product && typeof product === 'object' && 'active' in product) {
      if (!(product as StripeProduct).active) {
        throw new UnprocessableEntityException({
          code: 'STRIPE_PRODUCT_INACTIVE',
          message: 'Invalid Stripe price: associated product is not active',
        });
      }
    }
  }

  async createStripeSubscription(input: {
    stripeCustomerId: string;
    stripePriceId: string;
    internalSubscriptionId: string;
  }): Promise<{
    externalSubscriptionId: string;
    status: StripeSubscriptionStatus;
    /**
     * Opcional porque a ausência é um estado real da API, não um imprevisto: o
     * campo mudou de lugar entre versões. Antes o tipo prometia sempre uma data
     * e o código a fabricava a partir do `billing_cycle_anchor` para cumprir a
     * promessa - inventando um "fim de período" que era o começo dele.
     */
    currentPeriodEnd?: Date;
    clientSecret: string;
  }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    try {
      this.logger.log(
        `[Stripe subscription] Creating for customer=${input.stripeCustomerId} price=${input.stripePriceId}`,
      );

      const sub = await getStripeClient().subscriptions.create({
        customer: input.stripeCustomerId,
        items: [{ price: input.stripePriceId }],
        payment_behavior: 'default_incomplete',
        collection_method: 'charge_automatically',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
        // confirmation_secret is the current field in clover+ API (replaces payment_intent on Invoice).
        // payment_intent is kept for backwards compatibility with pre-clover API versions.
        expand: [
          'latest_invoice.confirmation_secret',
          'latest_invoice.payment_intent',
        ],
        metadata: { internalSubscriptionId: input.internalSubscriptionId },
      });

      const subRaw = sub as unknown as RawStripeSubscription;

      // latest_invoice may arrive as an expanded Invoice object or as a bare string ID
      let invoiceId: string | null = null;
      let invoice: RawStripeInvoice | null = null;
      const rawInvoice = subRaw.latest_invoice;

      if (typeof rawInvoice === 'string') {
        invoiceId = rawInvoice;
      } else if (rawInvoice && typeof rawInvoice === 'object') {
        invoice = rawInvoice;
        invoiceId = invoice.id ?? null;
      }

      // Retrieve the invoice explicitly when both confirmation_secret and payment_intent are absent.
      // Uses loose equality (== null) to catch both null and undefined.
      if (
        invoiceId &&
        invoice?.confirmation_secret == null &&
        invoice?.payment_intent == null
      ) {
        this.logger.log(
          `[Stripe subscription] confirmation_secret and payment_intent absent, retrieving invoice explicitly id=${invoiceId}`,
        );
        const fetched = await getStripeClient().invoices.retrieve(invoiceId, {
          expand: ['confirmation_secret', 'payment_intent'],
        });
        invoice = fetched as unknown as RawStripeInvoice;
      }

      let clientSecret: string | null = null;

      // Primary path (clover+ API): confirmation_secret replaced payment_intent on Invoice.
      const rawConfirmationSecret = invoice?.confirmation_secret;
      if (
        rawConfirmationSecret &&
        typeof rawConfirmationSecret === 'object' &&
        rawConfirmationSecret.client_secret
      ) {
        clientSecret = rawConfirmationSecret.client_secret;
      }

      // Fallback path (pre-clover API): payment_intent as expanded object or bare string ID.
      if (!clientSecret) {
        const rawPaymentIntent = invoice?.payment_intent;
        if (rawPaymentIntent && typeof rawPaymentIntent === 'object') {
          clientSecret = rawPaymentIntent.client_secret ?? null;
        } else if (typeof rawPaymentIntent === 'string') {
          this.logger.log(
            `[Stripe subscription] payment_intent as string ID, retrieving manually id=${rawPaymentIntent}`,
          );
          const pi =
            await getStripeClient().paymentIntents.retrieve(rawPaymentIntent);
          clientSecret = pi.client_secret ?? null;
        }
      }

      // Final fallback: retrieve invoice without expand to get payment_intent as a plain string ID,
      // then retrieve the PaymentIntent directly. Guards against API version edge cases where
      // the expand path changed or the field is returned differently.
      if (!clientSecret && invoiceId) {
        try {
          this.logger.log(
            `[Stripe subscription] Attempting plain-invoice fallback for clientSecret, invoiceId=${invoiceId}`,
          );
          const plainInvoice =
            await getStripeClient().invoices.retrieve(invoiceId);

          const { payment_intent: piId } =
            plainInvoice as unknown as RawStripeInvoice;
          if (typeof piId === 'string') {
            this.logger.log(
              `[Stripe subscription] Got payment_intent ID from plain invoice, retrieving pi=${piId}`,
            );
            const pi = await getStripeClient().paymentIntents.retrieve(piId);
            clientSecret = pi.client_secret ?? null;
          }
        } catch (fallbackError) {
          this.logger.warn(
            `[Stripe subscription] Plain-invoice fallback error: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`,
          );
        }
      }

      this.logger.log(
        `[Stripe subscription] sub=${sub.id} status=${sub.status} ` +
          `hasLatestInvoice=${!!invoice} hasClientSecret=${!!clientSecret}`,
      );

      if (!clientSecret) {
        const rawPI = invoice?.payment_intent;
        const piType = rawPI === null ? 'null' : typeof rawPI;

        const piId =
          typeof rawPI === 'string' ? rawPI : (rawPI?.id ?? 'unknown');
        const confirmationSecret =
          invoice?.confirmation_secret &&
          typeof invoice.confirmation_secret === 'object'
            ? invoice.confirmation_secret
            : null;

        this.logger.error(
          `[Stripe subscription] clientSecret missing — diagnostic: ` +
            `sub.id=${sub.id} sub.status=${sub.status} ` +
            `invoice.id=${invoice?.id ?? 'null'} invoice.status=${invoice?.status ?? 'null'} ` +
            `invoice.amount_due=${invoice?.amount_due ?? 'null'} ` +
            `invoice.collection_method=${invoice?.collection_method ?? 'null'} ` +
            `payment_intent.type=${piType} payment_intent.id=${piId} ` +
            `has_confirmation_secret=${!!confirmationSecret} ` +
            `has_confirmation_secret.client_secret=${!!confirmationSecret?.client_secret} ` +
            `invoice_keys=${Object.keys(invoice || {}).join(',')} ` +
            `priceId=${input.stripePriceId}`,
        );

        throw new InternalServerErrorException({
          code: 'STRIPE_CLIENT_SECRET_MISSING',
          message:
            'Paid Stripe subscription is incomplete but no clientSecret was found in latest invoice confirmation_secret or payment_intent.',
        });
      }

      const periodEnd =
        readCurrentPeriodEnd(subRaw) ?? readCurrentPeriodEnd(sub);

      return {
        externalSubscriptionId: sub.id,
        status: this.mapStripeSubscriptionStatus(sub.status),
        currentPeriodEnd: periodEnd,
        clientSecret,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Stripe subscription creation failed', error);
      throw new InternalServerErrorException({
        code: 'STRIPE_SUBSCRIPTION_CREATE_FAILED',
        message: 'Unable to create Stripe subscription',
      });
    }
  }

  mapStripeSubscriptionStatus(status: string): StripeSubscriptionStatus {
    switch (status) {
      case 'active':
        return 'ACTIVE';
      case 'trialing':
        return 'TRIALING';
      case 'past_due':
        return 'PAST_DUE';
      case 'canceled':
        return 'CANCELED';
      case 'unpaid':
        return 'UNPAID';
      case 'incomplete':
        return 'INCOMPLETE';
      case 'incomplete_expired':
        return 'EXPIRED';
      case 'paused':
        return 'PAUSED';
      default:
        return 'PENDING_PAYMENT';
    }
  }

  async getStripeSubscription(externalSubscriptionId: string): Promise<{
    externalSubscriptionId: string;
    status: StripeSubscriptionStatus;
    nextBillingAt?: Date;
    canceledAt?: Date;
  }> {
    const sub = (await this.retrieveSubscription(
      externalSubscriptionId,
    )) as any;
    const currentPeriodEnd = readCurrentPeriodEnd(sub);

    return {
      externalSubscriptionId: sub.id as string,
      status: this.mapStripeSubscriptionStatus(sub.status as string),
      nextBillingAt: currentPeriodEnd,
      canceledAt:
        typeof sub.canceled_at === 'number'
          ? new Date((sub.canceled_at as number) * 1000)
          : undefined,
    };
  }

  /**
   * Hosted Checkout — o caminho de quem contrata **sem** assinatura local.
   *
   * A identidade vai duas vezes, e as duas são necessárias. Na sessão, para
   * `checkout.session.completed` saber de quem é a compra. E em
   * `subscription_data.metadata`, porque `invoice.paid` — o evento que de fato
   * ativa o plano — carrega a *subscription*, nunca a sessão: sem carimbar ali,
   * a única cópia do `accountId` fica num objeto que aquele handler não vê, e o
   * pagamento chega sem dono.
   */
  async createCheckout(input: {
    accountId: string;
    planId: string;
    stripeCustomerId?: string;
    stripePriceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ checkoutUrl: string }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    const identity = {
      accountId: input.accountId,
      planId: input.planId,
    };

    const session = await getStripeClient().checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(input.stripeCustomerId ? { customer: input.stripeCustomerId } : {}),
      line_items: [
        {
          price: input.stripePriceId,
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: identity,
      subscription_data: { metadata: identity },
    });

    if (!session.url) {
      throw new InternalServerErrorException({
        code: 'STRIPE_CHECKOUT_FAILED',
        message: 'Stripe did not return checkout URL',
      });
    }

    return { checkoutUrl: session.url };
  }

  async cancelSubscription(input: { externalRef: string }): Promise<void> {
    if (!input.externalRef) {
      throw new InternalServerErrorException({
        code: 'STRIPE_SUBSCRIPTION_ID_REQUIRED',
        message: 'External subscription reference is required',
      });
    }

    await getStripeClient().subscriptions.update(input.externalRef, {
      cancel_at_period_end: true,
    });
  }

  /**
   * Moves a subscription to a different price (Sprint 6 follow-up: Stripe billing
   * migration).
   *
   * A Stripe subscription bills through its *items*, so a plan change is an update
   * to the existing item's price — not a new subscription. Creating a second
   * subscription (as the Mercado Pago flow did) would leave the customer paying
   * twice.
   *
   * `prorate` encodes the product decision, standard for SaaS:
   * - **upgrade** (`true`) → `always_invoice`: Stripe invoices the prorated
   *   difference immediately, so the customer pays for the better plan now;
   * - **downgrade** (`false`) → `none`: no credit and no charge now; the cheaper
   *   price simply applies from the next invoice. The caller keeps the customer on
   *   the current plan locally until the period ends, since they paid for it.
   */
  async changeSubscriptionPlan(input: {
    externalRef: string;
    newStripePriceId: string;
    prorate: boolean;
  }): Promise<{ status: StripeSubscriptionStatus; currentPeriodEnd?: Date }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    if (!input.externalRef) {
      throw new InternalServerErrorException({
        code: 'STRIPE_SUBSCRIPTION_ID_REQUIRED',
        message: 'External subscription reference is required',
      });
    }

    const current = (await getStripeClient().subscriptions.retrieve(
      input.externalRef,
    )) as any;

    // The item id is required: passing only a price would *add* a second item and
    // bill both plans together.
    const itemId = current?.items?.data?.[0]?.id as string | undefined;

    if (!itemId) {
      throw new UnprocessableEntityException({
        code: 'STRIPE_SUBSCRIPTION_ITEM_NOT_FOUND',
        message: `Stripe subscription ${input.externalRef} has no billable item to change`,
      });
    }

    try {
      const updated = (await getStripeClient().subscriptions.update(
        input.externalRef,
        {
          items: [{ id: itemId, price: input.newStripePriceId }],
          proration_behavior: input.prorate ? 'always_invoice' : 'none',
          // Keeps the subscription active if the prorated charge needs SCA rather
          // than dropping it to `incomplete` and revoking access mid-period.
          payment_behavior: 'pending_if_incomplete',
        } as any,
      )) as any;

      return {
        status: this.mapStripeSubscriptionStatus(updated?.status as string),
        currentPeriodEnd: readCurrentPeriodEnd(updated),
      };
    } catch (error) {
      this.logger.error(
        `Stripe plan change failed for ${input.externalRef}`,
        error instanceof Error ? error.message : error,
      );

      if (error instanceof HttpException) throw error;

      throw new UnprocessableEntityException({
        code: 'STRIPE_PLAN_CHANGE_FAILED',
        message: 'Unable to change the subscription plan at Stripe',
      });
    }
  }

  /**
   * Makes a payment method the one Stripe charges for a subscription
   * (`PUT /billing/payment-method` after the Stripe migration).
   *
   * The frontend confirms a SetupIntent — see {@link createSetupIntent} — which
   * yields a `payment_method` id. Three things then have to happen, and skipping any
   * one of them leaves the customer charged on the old card:
   *
   * 1. **attach** it to the customer (a payment method from a SetupIntent is not
   *    attached automatically in every flow);
   * 2. set it as the subscription's `default_payment_method` — this is what renewals
   *    actually use;
   * 3. set it as the customer's `invoice_settings.default_payment_method`, so any
   *    future subscription or one-off invoice uses it too.
   *
   * Returns the card details Stripe holds, so the local `BillingCard` shows the card
   * the customer will really be charged on rather than a stale copy.
   */
  async setSubscriptionPaymentMethod(input: {
    externalRef: string;
    stripeCustomerId: string;
    paymentMethodId: string;
  }): Promise<{
    externalCardId: string;
    brand?: string;
    lastFourDigits: string;
    expirationMonth: number;
    expirationYear: number;
    paymentMethod?: 'CREDIT_CARD' | 'DEBIT_CARD';
  }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    try {
      // Attaching an already-attached method is an error at Stripe, so a repeat of
      // the same card is tolerated rather than failing the whole change.
      const attached = (await getStripeClient()
        .paymentMethods.attach(input.paymentMethodId, {
          customer: input.stripeCustomerId,
        })
        .catch(async (error: unknown) => {
          this.logger.warn(
            `Stripe attach skipped for ${input.paymentMethodId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return getStripeClient().paymentMethods.retrieve(
            input.paymentMethodId,
          );
        })) as any;

      const card = attached?.card as Record<string, unknown> | undefined;

      if (!card) {
        throw new UnprocessableEntityException({
          code: 'STRIPE_PAYMENT_METHOD_NOT_A_CARD',
          message: 'The provided payment method is not a card',
        });
      }

      await getStripeClient().subscriptions.update(input.externalRef, {
        default_payment_method: input.paymentMethodId,
      } as any);

      await getStripeClient().customers.update(input.stripeCustomerId, {
        invoice_settings: {
          default_payment_method: input.paymentMethodId,
        },
      } as any);

      return {
        externalCardId: input.paymentMethodId,
        brand: card.brand as string | undefined,
        lastFourDigits: (card.last4 as string) ?? '****',
        expirationMonth: (card.exp_month as number) ?? 0,
        expirationYear: (card.exp_year as number) ?? 0,
        paymentMethod:
          card.funding === 'debit' ? 'DEBIT_CARD' : ('CREDIT_CARD' as const),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(
        `Stripe payment method update failed for ${input.externalRef}`,
        error instanceof Error ? error.message : error,
      );
      throw new UnprocessableEntityException({
        code: 'STRIPE_PAYMENT_METHOD_UPDATE_FAILED',
        message: 'Unable to update the subscription payment method at Stripe',
      });
    }
  }

  /**
   * Reads back the card a subscription is charged on.
   *
   * Checkout never told us which card was used: the client confirms the invoice's
   * PaymentIntent directly with Stripe.js, so the card exists only at Stripe. The
   * subscription is created with `save_default_payment_method: 'on_subscription'`,
   * which means Stripe records it as the subscription default once the first
   * payment succeeds — this is where we go get it.
   *
   * Three sources, in order of how strong a claim each makes about what renewals
   * will charge:
   *
   * 1. the subscription's own `default_payment_method`;
   * 2. the customer's `invoice_settings.default_payment_method`, which is what an
   *    older subscription left behind before the setting above existed;
   * 3. the customer's attached cards — but **only** when there is exactly one.
   *    With two or more, any pick would be a guess, and a guessed card shown as
   *    "the card you are charged on" is worse than showing none.
   *
   * Returns `null` rather than throwing when nothing resolves: a subscription with
   * no card on file is a normal state, not an error.
   */
  async getSubscriptionDefaultCard(
    externalSubscriptionId: string,
  ): Promise<StripeCardDetails | null> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    const sub = (await getStripeClient().subscriptions.retrieve(
      externalSubscriptionId,
      {
        expand: [
          'default_payment_method',
          'customer.invoice_settings.default_payment_method',
        ],
      },
    )) as unknown as RawStripeSubscription;

    const customer = sub.customer;
    const customerId =
      typeof customer === 'string' ? customer : (customer?.id ?? undefined);

    const candidates: StripePaymentMethodRef[] = [
      sub.default_payment_method,
      typeof customer === 'object'
        ? customer?.invoice_settings?.default_payment_method
        : undefined,
    ];

    for (const candidate of candidates) {
      const details = this.toCardDetails(
        await this.resolvePaymentMethod(candidate),
        customerId,
      );
      if (details) return details;
    }

    return customerId ? this.findSoleCustomerCard(customerId) : null;
  }

  private async resolvePaymentMethod(
    ref: StripePaymentMethodRef,
  ): Promise<RawStripePaymentMethod | null> {
    if (!ref) return null;

    if (typeof ref !== 'string') return ref;

    try {
      return (await getStripeClient().paymentMethods.retrieve(
        ref,
      )) as unknown as RawStripePaymentMethod;
    } catch (error) {
      this.logger.warn(
        `Stripe payment method ${ref} could not be retrieved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async findSoleCustomerCard(
    stripeCustomerId: string,
  ): Promise<StripeCardDetails | null> {
    try {
      // limit 2 so "exactly one" is answerable without paging the whole list.
      const result = await getStripeClient().paymentMethods.list({
        customer: stripeCustomerId,
        type: 'card',
        limit: 2,
      });

      const cards = (result?.data ?? []) as unknown as RawStripePaymentMethod[];

      if (cards.length !== 1) return null;

      return this.toCardDetails(cards[0], stripeCustomerId);
    } catch (error) {
      this.logger.warn(
        `Stripe card listing failed for customer ${stripeCustomerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private toCardDetails(
    paymentMethod: RawStripePaymentMethod | null,
    fallbackCustomerId?: string,
  ): StripeCardDetails | null {
    const card = paymentMethod?.card;

    if (!paymentMethod?.id || !card?.last4) return null;

    const attachedTo = paymentMethod.customer;
    const externalCustomerId =
      (typeof attachedTo === 'string' ? attachedTo : attachedTo?.id) ??
      fallbackCustomerId;

    if (!externalCustomerId) return null;

    return {
      externalCardId: paymentMethod.id,
      externalCustomerId,
      brand: card.brand,
      lastFourDigits: card.last4,
      expirationMonth: card.exp_month ?? 0,
      expirationYear: card.exp_year ?? 0,
      paymentMethod: card.funding === 'debit' ? 'DEBIT_CARD' : 'CREDIT_CARD',
    };
  }

  async retrieveSubscription(externalRef: string): Promise<StripeSubscription> {
    return getStripeClient().subscriptions.retrieve(externalRef);
  }

  /**
   * De quem é esta assinatura da Stripe, segundo o que o checkout carimbou.
   *
   * Existe para o caso em que o webhook chega antes de haver linha local para
   * casar por `externalSubscriptionId` — o que acontece de verdade, porque a
   * ordem entre `checkout.session.completed` e `invoice.paid` não é garantida
   * pela Stripe. Com a identidade no próprio objeto, qualquer um dos dois
   * eventos resolve a conta sozinho, e a ordem deixa de importar.
   *
   * Devolve campos vazios sem reclamar: assinaturas criadas por outros
   * caminhos (Stripe.js, Dashboard) não têm este metadata, e a ausência é uma
   * resposta legítima — não um erro.
   */
  async getSubscriptionIdentity(externalRef: string): Promise<{
    accountId?: string;
    planId?: string;
  }> {
    const subscription = (await this.retrieveSubscription(externalRef)) as {
      metadata?: Record<string, string | undefined> | null;
    };

    const metadata = subscription.metadata ?? {};

    return {
      accountId: metadata.accountId || undefined,
      planId: metadata.planId || undefined,
    };
  }

  async createSetupIntent(
    stripeCustomerId: string,
  ): Promise<{ clientSecret: string }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    try {
      const setupIntent = await getStripeClient().setupIntents.create({
        customer: stripeCustomerId,
        payment_method_types: ['card'],
        usage: 'off_session',
      });

      if (!setupIntent.client_secret) {
        throw new InternalServerErrorException({
          code: 'STRIPE_SETUP_INTENT_MISSING_SECRET',
          message: 'Stripe SetupIntent did not return a client_secret',
        });
      }

      return { clientSecret: setupIntent.client_secret };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Stripe SetupIntent creation failed', error);
      throw new InternalServerErrorException({
        code: 'STRIPE_SETUP_INTENT_FAILED',
        message: 'Unable to create Stripe SetupIntent',
      });
    }
  }

  async getInvoicePdfUrl(stripeInvoiceId: string): Promise<string | null> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    const invoice = await getStripeClient().invoices.retrieve(stripeInvoiceId);
    return (invoice as any).invoice_pdf ?? null;
  }

  /**
   * Lists recent invoices for a subscription, normalized for billing-history
   * backfill. Reconciliation uses this to recover invoices whose `invoice.paid`
   * webhook was never processed successfully.
   */
  async listSubscriptionInvoices(
    externalSubscriptionId: string,
    limit = 12,
  ): Promise<StripeNormalizedInvoice[]> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    const result = (await getStripeClient().invoices.list({
      subscription: externalSubscriptionId,
      limit,
    } as any)) as any;

    return ((result?.data ?? []) as any[]).map((invoice) => {
      const chargeId =
        typeof invoice.charge === 'string'
          ? invoice.charge
          : (invoice.charge?.id as string | undefined);
      const paidAtSeconds = invoice.status_transitions?.paid_at as
        | number
        | undefined;

      return {
        externalInvoiceId: invoice.id as string,
        externalPaymentId: chargeId,
        status: this.mapStripeInvoiceStatus(invoice.status as string),
        amount:
          ((invoice.amount_paid ?? invoice.amount_due ?? 0) as number) / 100,
        currency: ((invoice.currency as string) ?? 'usd').toUpperCase(),
        periodStart: invoice.period_start
          ? new Date((invoice.period_start as number) * 1000)
          : new Date(),
        periodEnd: invoice.period_end
          ? new Date((invoice.period_end as number) * 1000)
          : new Date(),
        paidAt: paidAtSeconds ? new Date(paidAtSeconds * 1000) : undefined,
      };
    });
  }

  mapStripeInvoiceStatus(status?: string): 'PAID' | 'PENDING' | 'FAILED' {
    if (status === 'paid') return 'PAID';
    if (status === 'uncollectible' || status === 'void') return 'FAILED';
    return 'PENDING';
  }

  async getClientSecretForIncompleteSubscription(
    externalSubscriptionId: string,
  ): Promise<{ clientSecret: string }> {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new InternalServerErrorException({
        code: 'STRIPE_NOT_CONFIGURED',
        message: 'Stripe is not configured in this environment',
      });
    }

    try {
      const sub = (await getStripeClient().subscriptions.retrieve(
        externalSubscriptionId,
        {
          expand: [
            'latest_invoice.confirmation_secret',
            'latest_invoice.payment_intent',
          ],
        },
      )) as any;

      let invoice: Record<string, unknown> | null = null;
      const rawInvoice = sub.latest_invoice;

      if (rawInvoice && typeof rawInvoice === 'object') {
        invoice = rawInvoice as Record<string, unknown>;
      } else if (typeof rawInvoice === 'string') {
        const fetched = await getStripeClient().invoices.retrieve(rawInvoice, {
          expand: ['confirmation_secret', 'payment_intent'],
        });
        invoice = fetched as unknown as Record<string, unknown>;
      }

      let clientSecret: string | null = null;

      const rawConfirmationSecret = invoice?.confirmation_secret as
        | Record<string, unknown>
        | null
        | undefined;
      if (rawConfirmationSecret?.client_secret) {
        clientSecret = rawConfirmationSecret.client_secret as string;
      }

      if (!clientSecret) {
        const rawPaymentIntent = invoice?.payment_intent;
        if (rawPaymentIntent && typeof rawPaymentIntent === 'object') {
          clientSecret =
            ((rawPaymentIntent as Record<string, unknown>)
              .client_secret as string) ?? null;
        } else if (typeof rawPaymentIntent === 'string') {
          const pi =
            await getStripeClient().paymentIntents.retrieve(rawPaymentIntent);
          clientSecret = pi.client_secret ?? null;
        }
      }

      if (!clientSecret && invoice?.id) {
        const plainInvoice = await getStripeClient().invoices.retrieve(
          invoice.id as string,
        );

        const piId = (plainInvoice as any).payment_intent;
        if (typeof piId === 'string') {
          const pi = await getStripeClient().paymentIntents.retrieve(piId);
          clientSecret = pi.client_secret ?? null;
        }
      }

      if (!clientSecret) {
        throw new InternalServerErrorException({
          code: 'STRIPE_CLIENT_SECRET_MISSING',
          message:
            'Could not retrieve clientSecret from existing incomplete Stripe subscription.',
        });
      }

      return { clientSecret };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        'Failed to retrieve clientSecret for incomplete subscription',
        error,
      );
      throw new InternalServerErrorException({
        code: 'STRIPE_CLIENT_SECRET_FETCH_FAILED',
        message: 'Unable to retrieve payment client secret from Stripe',
      });
    }
  }
}
