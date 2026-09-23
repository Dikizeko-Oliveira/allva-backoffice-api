import {
  BillingWebhookEventClaim,
  BillingWebhookEventRecord,
  BillingWebhookEventsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import type { StripeEvent } from 'src/modules/subscriptions/infrastructure/services/stripe.types';
import { HandleStripeWebhookUseCase } from './handle-stripe-webhook.usecase';

/**
 * Mirrors the Prisma repository semantics: an event is only a duplicate once it
 * has been marked processed.
 */
class FakeWebhookEventsRepository implements BillingWebhookEventsRepositoryInterface {
  readonly events = new Map<string, { processedAt: Date | null }>();

  async claim(
    event: BillingWebhookEventRecord,
  ): Promise<BillingWebhookEventClaim> {
    const existing = this.events.get(event.eventKey);

    if (!existing) {
      this.events.set(event.eventKey, { processedAt: null });
      return 'CLAIMED';
    }

    return existing.processedAt ? 'ALREADY_PROCESSED' : 'CLAIMED';
  }

  async markProcessed(eventKey: string): Promise<void> {
    const existing = this.events.get(eventKey);
    if (existing) existing.processedAt = new Date();
  }
}

function buildInvoicePaidEvent(): StripeEvent {
  return {
    id: 'evt_1',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_1',
        parent: { subscription_details: { subscription: 'sub_ext_1' } },
        period_start: 1700000000,
        period_end: 1702592000,
        amount_paid: 5000,
        currency: 'brl',
        status_transitions: { paid_at: 1700000100 },
        charge: 'ch_1',
      },
    },
  } as unknown as StripeEvent;
}

function buildHarness(options: { subscriptionFound?: boolean } = {}) {
  const subscription = {
    id: 'sub-local-1',
    accountId: 'acc-1',
    planId: 'plan-1',
    gracePeriodEndsAt: null as Date | null,
    activatePaidPlan: jest.fn(),
    markPastDue: jest.fn(),
    cancel: jest.fn(),
    syncWithProvider: jest.fn(),
    applyScheduledDowngradeIfDue: jest.fn().mockReturnValue(false),
  };

  const subscriptionsRepository = {
    findByExternalSubscriptionId: jest
      .fn()
      .mockResolvedValue(
        options.subscriptionFound === false ? null : subscription,
      ),
    findByAccountId: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const plansRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'plan-2', type: 'PRO' }),
  };

  const invoicesRepository = {
    findByExternalInvoiceId: jest.fn().mockResolvedValue(null),
    findLatestBySubscriptionId: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const paymentsRepository = {
    findByExternalPaymentId: jest.fn().mockResolvedValue(null),
    findByInvoiceId: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const stripeService = {
    mapStripeSubscriptionStatus: jest.fn().mockReturnValue('ACTIVE'),
    // Sem metadata é o caso das assinaturas criadas fora do Hosted Checkout,
    // que é o que estes testes exercitam.
    getSubscriptionIdentity: jest.fn().mockResolvedValue({}),
  };
  const organizationPlan = {
    syncPlanForOwner: jest.fn().mockResolvedValue(1),
    revokeForOwner: jest.fn().mockResolvedValue(1),
  };
  const webhookEvents = new FakeWebhookEventsRepository();
  const syncBillingCard = { execute: jest.fn().mockResolvedValue(null) };

  const useCase = new HandleStripeWebhookUseCase(
    stripeService as any,
    subscriptionsRepository as any,
    plansRepository as any,
    invoicesRepository as any,
    paymentsRepository as any,
    webhookEvents,
    organizationPlan as any,
    auditLog as any,
    syncBillingCard as any,
  );

  // The use case logs warn/error on every "not found" and on the rethrow path,
  // which are exactly the branches under test here.
  const logger = (useCase as any).logger;
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined);
  }

  return {
    useCase,
    webhookEvents,
    subscription,
    organizationPlan,
    syncBillingCard,
    subscriptionsRepository,
    plansRepository,
    invoicesRepository,
    paymentsRepository,
    auditLog,
    stripeService,
    logger,
  };
}

/** Minimal event envelope, so each test only states what it is about. */
function buildEvent(
  type: string,
  object: Record<string, unknown>,
): StripeEvent {
  return {
    id: `evt_${type}_${JSON.stringify(object).length}`,
    type,
    data: { object },
  } as unknown as StripeEvent;
}

const SUB_REF = { subscription_details: { subscription: 'sub_ext_1' } };

describe('HandleStripeWebhookUseCase — idempotency', () => {
  it('processes a first-time invoice.paid event and marks it processed', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.subscription.activatePaidPlan).toHaveBeenCalledTimes(1);
    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
    expect(h.paymentsRepository.save).toHaveBeenCalledTimes(1);
    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeInstanceOf(
      Date,
    );
  });

  it('skips a duplicate delivery of an already-processed event', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());
    await h.useCase.execute(buildInvoicePaidEvent());

    // Still exactly one invoice/payment — the duplicate did no work.
    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
    expect(h.paymentsRepository.save).toHaveBeenCalledTimes(1);
    expect(h.subscription.activatePaidPlan).toHaveBeenCalledTimes(1);
  });

  // The Sprint 1 acceptance criterion: a delivery that blows up mid-processing
  // must leave the event un-processed so the provider's retry completes it.
  it('reprocesses on retry when a previous attempt failed mid-flight', async () => {
    const h = buildHarness();
    h.invoicesRepository.save.mockRejectedValueOnce(new Error('db timeout'));

    await expect(h.useCase.execute(buildInvoicePaidEvent())).rejects.toThrow(
      'db timeout',
    );

    // Event was recorded but NOT marked processed.
    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeNull();

    // The provider retries the same event — this time it must go through.
    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(2);
    expect(h.paymentsRepository.save).toHaveBeenCalledTimes(1);
    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeInstanceOf(
      Date,
    );
  });
});

/**
 * O plano pago tem de descer para a organização.
 *
 * `organization_subscriptions` é a única fonte de
 * `findPlanTypeByOrganizationId`, e ela responde às dezesseis guardas de
 * `ENFORCED_FEATURE_KEYS`. A troca de plano já propagava; a **primeira**
 * assinatura não — ela nasce `PENDING_PAYMENT` em `CreateSubscriptionUseCase` e
 * é este evento que a ativa. Sem a propagação a organização ficava no teste
 * FREE, que espelha o PRO: quem assinava o Individual levava o Profissional.
 */
describe('HandleStripeWebhookUseCase — plano da organização', () => {
  it('propaga o plano pago para as organizações do dono', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.organizationPlan.syncPlanForOwner).toHaveBeenCalledWith({
      ownerAccountId: 'acc-1',
      planId: 'plan-1',
    });
  });

  /**
   * Este teste fixava o oposto: que a falha era engolida para não reentregar o
   * evento, "que a idempotência trataria como duplicata". A premissa estava
   * errada — `markProcessed` só roda depois do `switch`, então um erro deixa
   * `processedAt` nulo e a reentrega é reprocessada normalmente, como o teste de
   * retry sempre documentou.
   *
   * Com a premissa errada, o `catch` transformava uma falha transitória de banco
   * em divergência definitiva: log, evento marcado como processado, e nenhuma
   * reconciliação relendo isto depois. O cliente pagava e ficava com as features
   * do plano anterior para sempre.
   */
  it('deixa a Stripe reentregar quando a propagação falha', async () => {
    const h = buildHarness();
    h.organizationPlan.syncPlanForOwner.mockRejectedValueOnce(
      new Error('db timeout'),
    );

    await expect(h.useCase.execute(buildInvoicePaidEvent())).rejects.toThrow(
      'db timeout',
    );

    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeNull();
  });

  /**
   * `updateMany` não falha quando não encontra nada. Zero linhas faz o mesmo
   * estrago de uma exceção, só que mudo — e precisa aparecer no log.
   */
  it('denuncia quando o plano pago não alcança organização nenhuma', async () => {
    const h = buildHarness();
    h.organizationPlan.syncPlanForOwner.mockResolvedValue(0);

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('reached no organization'),
    );
  });
});

/**
 * O cancelamento tem de descer para a organização.
 *
 * Sem isto ele só valia metade: a conta virava `CANCELED` e a organização
 * seguia `ACTIVE` com o plano pago gravado. Como `resolve()` devolve o contexto
 * mais permissivo dos dois, o produto continuava aberto depois de a cobrança
 * acabar — e as guardas de feature, que leem a organização direto, entregavam o
 * plano pago sem pagamento nenhum, sem prazo para acabar.
 */
describe('HandleStripeWebhookUseCase — revogação da organização', () => {
  it('revoga as organizações do dono quando a assinatura é deletada', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('customer.subscription.deleted', { id: 'sub_ext_1' }),
    );

    expect(h.organizationPlan.revokeForOwner).toHaveBeenCalledWith({
      ownerAccountId: 'acc-1',
      status: 'CANCELED',
    });
  });

  it('deixa a Stripe reentregar quando a revogação falha', async () => {
    // Falhar aqui deixa acesso pago aberto sem pagamento - o lado errado para
    // errar em silêncio.
    const h = buildHarness();
    h.organizationPlan.revokeForOwner.mockRejectedValueOnce(
      new Error('db down'),
    );

    await expect(
      h.useCase.execute(
        buildEvent('customer.subscription.deleted', { id: 'sub_ext_1' }),
      ),
    ).rejects.toThrow('db down');

    expect([...h.webhookEvents.events.values()][0].processedAt).toBeNull();
  });
});

describe('HandleStripeWebhookUseCase — cartão do checkout', () => {
  it('grava o cartão que só existia na Stripe quando o pagamento entra', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.syncBillingCard.execute).toHaveBeenCalledWith(h.subscription);
  });

  it('não derruba o webhook quando a Stripe não devolve o cartão', async () => {
    // Mesma razão do bloco de plano acima: a fatura e o pagamento já foram
    // gravados, e a leitura de `/billing/payment-method` refaz esta
    // sincronização sozinha.
    const h = buildHarness();
    h.syncBillingCard.execute.mockRejectedValueOnce(new Error('stripe down'));

    await expect(
      h.useCase.execute(buildInvoicePaidEvent()),
    ).resolves.toBeUndefined();

    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeInstanceOf(
      Date,
    );
  });
});

describe('HandleStripeWebhookUseCase — audit trail', () => {
  it('records payment.succeeded and subscription.activated on invoice.paid', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());

    const events = h.auditLog.record.mock.calls.map((call) => call[0].event);
    expect(events).toContain('payment.succeeded');
    expect(events).toContain('subscription.activated');
  });

  it('records payment.failed and subscription.past_due on invoice.payment_failed', async () => {
    const h = buildHarness();
    const event = {
      id: 'evt_2',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_2',
          parent: { subscription_details: { subscription: 'sub_ext_1' } },
          next_payment_attempt: 1700500000,
        },
      },
    } as unknown as StripeEvent;

    await h.useCase.execute(event);

    const events = h.auditLog.record.mock.calls.map((call) => call[0].event);
    expect(h.subscription.markPastDue).toHaveBeenCalledTimes(1);
    expect(events).toContain('payment.failed');
    expect(events).toContain('subscription.past_due');
  });

  it('records subscription.canceled on customer.subscription.deleted', async () => {
    const h = buildHarness();
    const event = {
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_ext_1' } },
    } as unknown as StripeEvent;

    await h.useCase.execute(event);

    const events = h.auditLog.record.mock.calls.map((call) => call[0].event);
    expect(h.subscription.cancel).toHaveBeenCalledTimes(1);
    expect(events).toContain('subscription.canceled');
  });
});

describe('HandleStripeWebhookUseCase — subscription id resolution', () => {
  /**
   * The clover API moved the subscription reference to
   * `invoice.parent.subscription_details.subscription`, and each shape below is
   * one Stripe actually sends. Failing to read it means the invoice silently
   * does nothing — the money arrived and the subscription never activated.
   */
  it.each([
    ['clover, as a string', { parent: SUB_REF }],
    [
      'clover, as an expanded object',
      {
        parent: { subscription_details: { subscription: { id: 'sub_ext_1' } } },
      },
    ],
    ['legacy, as a string', { subscription: 'sub_ext_1' }],
    ['legacy, as an expanded object', { subscription: { id: 'sub_ext_1' } }],
  ])('reads the subscription %s', async (_label, shape) => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_x', ...shape }),
    );

    expect(
      h.subscriptionsRepository.findByExternalSubscriptionId,
    ).toHaveBeenCalledWith('sub_ext_1');
    expect(h.subscription.activatePaidPlan).toHaveBeenCalledTimes(1);
  });

  it('gives up quietly when the invoice carries no subscription', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildEvent('invoice.paid', { id: 'in_orphan' }));

    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
    // Still marked processed: retrying an invoice with no subscription would
    // fail identically forever.
    expect([...h.webhookEvents.events.values()][0].processedAt).toBeInstanceOf(
      Date,
    );
  });

  it('does nothing when no local subscription matches', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });
});

describe('HandleStripeWebhookUseCase — invoice.paid field handling', () => {
  it('converts amounts from cents and upper-cases the currency', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.paid', {
        id: 'in_1',
        parent: SUB_REF,
        amount_paid: 12345,
        currency: 'brl',
      }),
    );

    const [saved] = h.invoicesRepository.save.mock.calls[0];
    expect(saved.amount).toBe(123.45);
    expect(saved.currency).toBe('BRL');
  });

  it('defaults a missing amount to zero and a missing currency to USD', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    const [saved] = h.invoicesRepository.save.mock.calls[0];
    expect(saved.amount).toBe(0);
    expect(saved.currency).toBe('USD');
  });

  it('derives a period end when Stripe omits one', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.paid', {
        id: 'in_1',
        parent: SUB_REF,
        period_start: 1700000000,
      }),
    );

    const [saved] = h.invoicesRepository.save.mock.calls[0];
    expect(saved.periodStart).toEqual(new Date(1700000000 * 1000));
    // Roughly a month later, never before the start.
    expect(saved.periodEnd.getTime()).toBeGreaterThan(
      saved.periodStart.getTime(),
    );
  });

  it('reads the charge id whether it is a string or an expanded object', async () => {
    for (const charge of ['ch_1', { id: 'ch_1' }]) {
      const h = buildHarness();

      await h.useCase.execute(
        buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF, charge }),
      );

      expect(h.paymentsRepository.findByExternalPaymentId).toHaveBeenCalledWith(
        'ch_1',
      );
    }
  });
});

describe('HandleStripeWebhookUseCase — invoice and payment reuse', () => {
  it('reuses the invoice already recorded for that Stripe id', async () => {
    const h = buildHarness();
    const existing = {
      id: 'inv-existing',
      syncExternalInvoice: jest.fn(),
      updateStatus: jest.fn(),
    };
    h.invoicesRepository.findByExternalInvoiceId.mockResolvedValue(existing);
    h.invoicesRepository.findById.mockResolvedValue(existing);

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    // Update, never a second insert — the alternative is duplicate billing rows.
    expect(h.invoicesRepository.update).toHaveBeenCalledTimes(1);
    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
    expect(existing.updateStatus).toHaveBeenCalledWith('PAID');
  });

  it('adopts the pending invoice created at checkout instead of a new one', async () => {
    const h = buildHarness();
    const pending = {
      id: 'inv-pending',
      status: 'PENDING',
      externalInvoiceId: undefined,
      syncExternalInvoice: jest.fn(),
      updateStatus: jest.fn(),
    };
    h.invoicesRepository.findLatestBySubscriptionId.mockResolvedValue(pending);

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    expect(pending.syncExternalInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ externalInvoiceId: 'in_1' }),
    );
    expect(pending.updateStatus).toHaveBeenCalledWith('PAID');
  });

  it('does not adopt a pending invoice that already belongs to another Stripe invoice', async () => {
    const h = buildHarness();
    h.invoicesRepository.findLatestBySubscriptionId.mockResolvedValue({
      id: 'inv-other',
      status: 'PENDING',
      externalInvoiceId: 'in_other',
      syncExternalInvoice: jest.fn(),
      updateStatus: jest.fn(),
    });

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing payment found by charge id', async () => {
    const h = buildHarness();
    const existing = { id: 'pay-1', updateFromProvider: jest.fn() };
    h.paymentsRepository.findByExternalPaymentId.mockResolvedValue(existing);
    h.paymentsRepository.findById.mockResolvedValue(existing);

    await h.useCase.execute(
      buildEvent('invoice.paid', {
        id: 'in_1',
        parent: SUB_REF,
        charge: 'ch_1',
      }),
    );

    expect(h.paymentsRepository.update).toHaveBeenCalledTimes(1);
    expect(h.paymentsRepository.save).not.toHaveBeenCalled();
  });

  it('falls back to the payment attached to the invoice when there is no charge id', async () => {
    const h = buildHarness();
    const existing = { id: 'pay-1', updateFromProvider: jest.fn() };
    h.paymentsRepository.findByInvoiceId.mockResolvedValue(existing);

    await h.useCase.execute(
      buildEvent('invoice.paid', { id: 'in_1', parent: SUB_REF }),
    );

    expect(h.paymentsRepository.findByExternalPaymentId).not.toHaveBeenCalled();
    expect(existing.updateFromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'APPROVED' }),
    );
  });
});

describe('HandleStripeWebhookUseCase — payment failure', () => {
  it('ignores a failure with no subscription reference', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.payment_failed', { id: 'in_orphan' }),
    );

    expect(h.subscription.markPastDue).not.toHaveBeenCalled();
  });

  it('ignores a failure for an unknown local subscription', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('invoice.payment_failed', { id: 'in_1', parent: SUB_REF }),
    );

    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });

  it('passes the next retry date through when Stripe schedules one', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.payment_failed', {
        id: 'in_1',
        parent: SUB_REF,
        next_payment_attempt: 1700500000,
      }),
    );

    expect(h.subscription.markPastDue).toHaveBeenCalledWith(
      new Date(1700500000 * 1000),
    );
  });

  it('marks past due with no retry date when Stripe gave up', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('invoice.payment_failed', { id: 'in_1', parent: SUB_REF }),
    );

    expect(h.subscription.markPastDue).toHaveBeenCalledWith(undefined);
  });
});

describe('HandleStripeWebhookUseCase — subscription.updated', () => {
  it('ignores an unknown local subscription', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
      }),
    );

    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
  });

  it('syncs the mapped status and the renewal date', async () => {
    const h = buildHarness();
    h.stripeService.mapStripeSubscriptionStatus.mockReturnValue('ACTIVE');

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
        current_period_end: 1702592000,
      }),
    );

    expect(h.subscription.syncWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ACTIVE',
        nextBillingAt: new Date(1702592000 * 1000),
      }),
    );
  });

  it('reads current_period_end from the subscription item (current API shape)', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
        billing_cycle_anchor: 1702592000,
        items: { data: [{ current_period_end: 1800000000 }] },
      }),
    );

    expect(h.subscription.syncWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({ nextBillingAt: new Date(1800000000 * 1000) }),
    );
  });

  it('does NOT fall back to billing_cycle_anchor when no period end is available', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
        billing_cycle_anchor: 1702592000,
      }),
    );

    /**
     * O âncora é o início do ciclo. Gravá-lo como `nextBillingAt` punha uma
     * data passada no campo que `applyScheduledDowngradeIfDue()` consulta - e
     * era assim que o downgrade "para o fim do período" virava imediato.
     */
    expect(h.subscription.syncWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({ nextBillingAt: undefined }),
    );
  });

  it('leaves the renewal date alone when Stripe sends neither', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
      }),
    );

    expect(h.subscription.syncWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({ nextBillingAt: undefined }),
    );
  });

  it('carries the cancellation timestamp through when present', async () => {
    const h = buildHarness();

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'canceled',
        canceled_at: 1702000000,
      }),
    );

    expect(h.subscription.syncWithProvider).toHaveBeenCalledWith(
      expect.objectContaining({ canceledAt: new Date(1702000000 * 1000) }),
    );
  });

  /**
   * A downgrade requested via `POST /billing/subscription/change` waits for the
   * paid period to end. Stripe renewing the subscription *is* that moment, so
   * this webhook is where the cheaper plan finally takes effect locally — if it
   * did not, the customer would keep the expensive plan they stopped paying for.
   */
  it('applies a scheduled downgrade when the renewal makes it due', async () => {
    const h = buildHarness();
    h.subscription.applyScheduledDowngradeIfDue.mockReturnValue(true);

    await h.useCase.execute(
      buildEvent('customer.subscription.updated', {
        id: 'sub_ext_1',
        status: 'active',
      }),
    );

    expect(h.subscription.applyScheduledDowngradeIfDue).toHaveBeenCalledTimes(
      1,
    );
    expect(h.subscriptionsRepository.update).toHaveBeenCalledTimes(1);
  });
});

describe('HandleStripeWebhookUseCase — subscription.deleted', () => {
  it('ignores an unknown local subscription', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('customer.subscription.deleted', { id: 'sub_ext_1' }),
    );

    expect(h.subscription.cancel).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });
});

describe('HandleStripeWebhookUseCase — event types with no work to do', () => {
  it.each([
    'customer.subscription.created',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'charge.refunded',
  ])('acknowledges %s without touching state', async (type) => {
    const h = buildHarness();

    await h.useCase.execute(buildEvent(type, { id: 'obj_1' }));

    expect(h.subscriptionsRepository.update).not.toHaveBeenCalled();
    expect(h.invoicesRepository.save).not.toHaveBeenCalled();
    // Acknowledged, so Stripe stops redelivering it.
    expect([...h.webhookEvents.events.values()][0].processedAt).toBeInstanceOf(
      Date,
    );
  });

  it('falls back to the event id when the payload object has none', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildEvent('charge.refunded', {}));

    expect([...h.webhookEvents.events.keys()][0]).toMatch(/^evt_/);
  });
});

describe('HandleStripeWebhookUseCase — failure propagation', () => {
  it('rethrows so the provider retries, leaving the event unprocessed', async () => {
    const h = buildHarness();
    h.subscriptionsRepository.update.mockRejectedValue(new Error('db down'));

    await expect(
      h.useCase.execute(
        buildEvent('customer.subscription.deleted', { id: 'sub_ext_1' }),
      ),
    ).rejects.toThrow('db down');

    expect([...h.webhookEvents.events.values()][0].processedAt).toBeNull();
  });

  it('rethrows a non-Error rejection too', async () => {
    const h = buildHarness();
    h.subscriptionsRepository.update.mockRejectedValue('plain string');

    await expect(
      h.useCase.execute(
        buildEvent('customer.subscription.deleted', { id: 'sub_ext_1' }),
      ),
    ).rejects.toBe('plain string');
  });
});

/**
 * O Hosted Checkout — o caminho de quem sobe do teste gratuito para um plano
 * pago.
 *
 * Diferente do Stripe.js, aqui a compra acontece **fora** da API: quando o
 * webhook chega pode não haver linha local nenhuma para casar por
 * `externalSubscriptionId`. Antes destes testes o não-encontrado virava um
 * `warn` e um `return` com o dinheiro já dentro — cliente cobrado, conta sem
 * plano, e nenhum erro em lugar nenhum.
 */
describe('HandleStripeWebhookUseCase — Hosted Checkout', () => {
  const CHECKOUT_METADATA = { accountId: 'acc-1', planId: 'plan-2' };

  function buildCheckoutEvent() {
    return buildEvent('checkout.session.completed', {
      id: 'cs_1',
      subscription: 'sub_ext_1',
      metadata: CHECKOUT_METADATA,
    });
  }

  it('creates and links a local subscription when the account has none', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(buildCheckoutEvent());

    expect(h.subscriptionsRepository.save).toHaveBeenCalledTimes(1);

    const [saved] = h.subscriptionsRepository.save.mock.calls[0];
    expect(saved.accountId).toBe('acc-1');
    expect(saved.planId).toBe('plan-2');
    expect(saved.externalSubscriptionId).toBe('sub_ext_1');
  });

  /**
   * A linha nasce `PENDING_PAYMENT`, e é o que garante que abrir o checkout não
   * entregue o plano: quem desistir no formulário do cartão não leva nada.
   */
  it('does not grant the plan before the payment lands', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(buildCheckoutEvent());

    const [saved] = h.subscriptionsRepository.save.mock.calls[0];
    expect(saved.billingStatus).toBe('PENDING_PAYMENT');
    expect(h.organizationPlan.syncPlanForOwner).not.toHaveBeenCalled();
  });

  it('links to the existing row instead of creating a second one', async () => {
    const h = buildHarness({ subscriptionFound: false });
    h.subscriptionsRepository.findByAccountId.mockResolvedValue({
      ...h.subscription,
      attachProviderSubscription: jest.fn(),
    });

    await h.useCase.execute(buildCheckoutEvent());

    expect(h.subscriptionsRepository.save).not.toHaveBeenCalled();
    expect(h.subscriptionsRepository.update).toHaveBeenCalledTimes(1);
  });

  it('ignores a session that carries no subscription', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('checkout.session.completed', {
        id: 'cs_2',
        metadata: CHECKOUT_METADATA,
      }),
    );

    expect(h.subscriptionsRepository.save).not.toHaveBeenCalled();
  });

  it('refuses to guess when the session has no identity metadata', async () => {
    const h = buildHarness({ subscriptionFound: false });

    await h.useCase.execute(
      buildEvent('checkout.session.completed', {
        id: 'cs_3',
        subscription: 'sub_ext_1',
      }),
    );

    expect(h.subscriptionsRepository.save).not.toHaveBeenCalled();
  });

  /**
   * A Stripe não garante ordem entre `checkout.session.completed` e
   * `invoice.paid`. Chegando o pagamento primeiro, a identidade é lida do
   * metadata da própria assinatura — que `createCheckout` carimba justamente
   * para isto.
   */
  it('recovers when invoice.paid arrives before the checkout event', async () => {
    const h = buildHarness({ subscriptionFound: false });
    h.stripeService.getSubscriptionIdentity.mockResolvedValue(
      CHECKOUT_METADATA,
    );

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.subscriptionsRepository.save).toHaveBeenCalledTimes(1);
    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
    expect(h.organizationPlan.syncPlanForOwner).toHaveBeenCalledWith({
      ownerAccountId: 'acc-1',
      planId: 'plan-2',
    });
  });

  /**
   * `activatePaidPlan` reusava o `planId` local. Com a compra acontecendo fora
   * da API, esse plano pode ser o anterior — e o pagamento do Profissional
   * ativaria o plano velho, com a fatura certa e o acesso errado.
   */
  it('activates the plan that was actually purchased', async () => {
    const h = buildHarness();
    h.stripeService.getSubscriptionIdentity.mockResolvedValue(
      CHECKOUT_METADATA,
    );

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.subscription.activatePaidPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'plan-2' }),
    );
  });

  /** Sem metadata (Stripe.js, Dashboard) o plano local segue mandando. */
  it('keeps using the local plan when there is no purchase metadata', async () => {
    const h = buildHarness();

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.subscription.activatePaidPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'plan-1' }),
    );
  });

  it('gives up on metadata pointing at a plan that does not exist', async () => {
    const h = buildHarness({ subscriptionFound: false });
    h.plansRepository.findById.mockResolvedValue(null);

    await h.useCase.execute(buildCheckoutEvent());

    expect(h.subscriptionsRepository.save).not.toHaveBeenCalled();
  });
});

describe('HandleStripeWebhookUseCase — identidade indisponível', () => {
  /**
   * Sem linha local, o metadata é a única identificação do pagamento. Engolir a
   * falha aqui deixaria dinheiro sem dono; estourando, a Stripe reentrega.
   */
  it('rethrows when the identity lookup fails and there is no local row', async () => {
    const h = buildHarness({ subscriptionFound: false });
    h.stripeService.getSubscriptionIdentity.mockRejectedValue(
      new Error('stripe down'),
    );

    await expect(h.useCase.execute(buildInvoicePaidEvent())).rejects.toThrow(
      'stripe down',
    );

    expect(h.webhookEvents.events.get('evt_1')?.processedAt).toBeNull();
  });

  /** Com linha local a leitura é opcional - a renovação não pode ficar presa. */
  it('processes the invoice anyway when the row is already linked', async () => {
    const h = buildHarness();
    h.stripeService.getSubscriptionIdentity.mockRejectedValue(
      new Error('stripe down'),
    );

    await h.useCase.execute(buildInvoicePaidEvent());

    expect(h.invoicesRepository.save).toHaveBeenCalledTimes(1);
    expect(h.subscription.activatePaidPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'plan-1' }),
    );
  });
});
