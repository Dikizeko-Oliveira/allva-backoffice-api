import { Injectable, Logger } from '@nestjs/common';
import type { StripeEvent } from 'src/modules/subscriptions/infrastructure/services/stripe.types';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { Invoice } from 'src/modules/invoices/domain/entities';
import {
  BillingWebhookEventsRepositoryInterface,
  PaymentsRepositoryInterface,
  SubscriptionsRepositoryInterface,
} from 'src/modules/subscriptions/domain/ports';
import {
  Payment,
  Subscription,
} from 'src/modules/subscriptions/domain/entities';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { BillingStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { SyncSubscriptionBillingCardUseCase } from './sync-subscription-billing-card.usecase';

/**
 * In the clover API `invoice.subscription` moved to
 * `invoice.parent.subscription_details.subscription`, and `current_period_end`
 * was dropped from the Subscription type while still being sent. Both shapes
 * below describe only the fields this use case reads.
 *
 * These were `Record<string, any>`, which made every access below unchecked —
 * a typo in a Stripe field name compiled fine and silently produced `undefined`,
 * on the path that decides whether a payment activates a subscription.
 */
type StripeRef = string | { id?: string } | null | undefined;

type StripeInvoiceRaw = {
  id?: string;
  amount_paid?: number;
  currency?: string;
  period_start?: number;
  period_end?: number;
  next_payment_attempt?: number;
  charge?: StripeRef;
  subscription?: StripeRef;
  parent?: { subscription_details?: { subscription?: StripeRef } } | null;
  status_transitions?: { paid_at?: number } | null;
};

type StripeSubscriptionRaw = {
  id?: string;
  status?: string;
  current_period_end?: number;
  billing_cycle_anchor?: number;
  items?: { data?: Array<{ current_period_end?: number | null }> };
  canceled_at?: number;
};

type StripeCheckoutSessionRaw = {
  id?: string;
  subscription?: StripeRef;
  metadata?: { accountId?: string; planId?: string } | null;
};

@Injectable()
export class HandleStripeWebhookUseCase {
  private readonly logger = new Logger(HandleStripeWebhookUseCase.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly invoicesRepository: InvoicesRepositoryInterface,
    private readonly paymentsRepository: PaymentsRepositoryInterface,
    private readonly billingWebhookEventsRepository: BillingWebhookEventsRepositoryInterface,
    private readonly organizationPlan: OrganizationPlanPortInterface,
    private readonly auditLog: AuditLogService,
    private readonly syncSubscriptionBillingCard: SyncSubscriptionBillingCardUseCase,
  ) {}

  async execute(event: StripeEvent): Promise<void> {
    const eventKey = event.id;
    const topic = event.type;
    const resourceId = (event.data.object as { id?: string }).id ?? event.id;

    const claim = await this.billingWebhookEventsRepository.claim({
      provider: 'STRIPE',
      eventKey,
      topic,
      externalEventId: event.id,
      resourceId,
      payload: event as unknown as Record<string, unknown>,
    });

    // Only a fully-processed event is a real duplicate. An event that was
    // recorded but never completed is retried here rather than dropped.
    if (claim === 'ALREADY_PROCESSED') {
      this.logger.debug(`Skipping already-processed Stripe event ${eventKey}`);
      return;
    }

    try {
      switch (event.type) {
        case 'invoice.paid':
          await this.handleInvoicePaid(
            event.data.object as unknown as StripeInvoiceRaw,
          );
          break;
        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(
            event.data.object as unknown as StripeInvoiceRaw,
          );
          break;
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdated(
            event.data.object as unknown as StripeSubscriptionRaw,
          );
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionDeleted(
            event.data.object as unknown as StripeSubscriptionRaw,
          );
          break;
        case 'checkout.session.completed':
          await this.handleCheckoutSessionCompleted(
            event.data.object as unknown as StripeCheckoutSessionRaw,
          );
          break;
        case 'customer.subscription.created':
          // No Stripe.js a linha local nasce antes de a Stripe confirmar, e não
          // há o que fazer aqui. No Hosted Checkout quem amarra conta ↔
          // assinatura é `checkout.session.completed`, que carrega o metadata —
          // este evento não o traz de forma confiável.
          this.logger.log(
            `Stripe subscription created via webhook: ${resourceId}`,
          );
          break;
        case 'payment_intent.succeeded':
        case 'payment_intent.payment_failed':
          // Handled via invoice.paid / invoice.payment_failed (Stripe recommended approach for subscriptions).
          this.logger.debug(
            `Stripe event ${event.type} received for ${resourceId} (handled via invoice events)`,
          );
          break;
        default:
          this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
      }

      await this.billingWebhookEventsRepository.markProcessed(eventKey);
    } catch (error) {
      this.logger.error(
        `Stripe webhook processing failed for ${eventKey}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  private resolveStripeSubscriptionId(
    invoice: StripeInvoiceRaw,
  ): string | undefined {
    // clover API: invoice.parent.subscription_details.subscription
    const fromParent = invoice?.parent?.subscription_details?.subscription;
    if (fromParent) {
      return typeof fromParent === 'string' ? fromParent : fromParent.id;
    }
    // Fallback for older API shape (still present in response data)
    const direct = invoice?.subscription;
    if (direct) {
      return typeof direct === 'string' ? direct : direct.id;
    }
    return undefined;
  }

  /**
   * A assinatura local desta assinatura da Stripe - criando-a se for o caso.
   *
   * O caminho normal é casar por `externalSubscriptionId`. Ele falha para quem
   * contratou pelo Hosted Checkout **sem** assinatura local prévia: a linha só
   * nasce quando um destes eventos chega, e a Stripe não garante que
   * `checkout.session.completed` venha antes de `invoice.paid`.
   *
   * Antes disso, o não-encontrado virava um `warn` e um `return` - e o dinheiro
   * já tinha entrado. O cliente pagava e a conta continuava sem plano, sem erro
   * em lugar nenhum: o pior formato possível para uma falha de cobrança.
   *
   * A identidade vem do metadata que `createCheckout` carimba na assinatura.
   * Sem ele não há o que fazer aqui - é assinatura de outra origem, e continuar
   * seria adivinhar de quem é o pagamento.
   */
  private async resolveLocalSubscription(
    stripeSubscriptionId: string,
  ): Promise<{ subscription: Subscription; purchasedPlanId?: string } | null> {
    const linked =
      await this.subscriptionsRepository.findByExternalSubscriptionId(
        stripeSubscriptionId,
      );

    /**
     * "Não tem metadata" e "não consegui ler o metadata" não podem terminar
     * igual, e é a diferença entre uma renovação e um pagamento órfão.
     *
     * Com linha local, a leitura é um aperfeiçoamento: ela diz qual plano foi
     * comprado, e na renovação mensal repete o que já está gravado. Uma falha
     * aí não pode segurar a fatura, então vira `undefined` e o plano local
     * manda.
     *
     * **Sem** linha local ela é a única identificação que existe. Aqui a mesma
     * falha significa deixar um pagamento sem dono, e o certo é estourar: a
     * Stripe reentrega o evento, e `billingWebhookEventsRepository` só o
     * considera duplicata depois de processado com sucesso.
     */
    const identity = await this.stripeService
      .getSubscriptionIdentity(stripeSubscriptionId)
      .catch((error: unknown) => {
        if (linked) return { accountId: undefined, planId: undefined };
        throw error;
      });

    if (linked) {
      return { subscription: linked, purchasedPlanId: identity.planId };
    }

    if (!identity.accountId || !identity.planId) return null;

    const subscription = await this.attachToAccount({
      accountId: identity.accountId,
      planId: identity.planId,
      stripeSubscriptionId,
    });

    return subscription
      ? { subscription, purchasedPlanId: identity.planId }
      : null;
  }

  /**
   * Liga a assinatura da Stripe à conta - reaproveitando a linha se já houver.
   *
   * `Subscription.accountId` é único, então uma conta tem no máximo uma linha:
   * quem já assinou antes tem a dela, quem está no teste gratuito da
   * organização não tem nenhuma. Os dois casos convergem aqui.
   *
   * **Nada de plano é concedido nesta passagem**, e a distinção importa. Numa
   * linha que já existe só o vínculo com o provedor é gravado: escrever o plano
   * comprado aqui entregaria o plano pago no instante em que o cliente *abre* o
   * checkout, e quem desistisse no formulário do cartão ficaria com ele de
   * graça. Quem concede é `invoice.paid`, com o dinheiro já dentro.
   *
   * Na linha nova o plano vai junto porque `createPendingPayment` exige um, mas
   * ela nasce `PENDING_PAYMENT` - que não dá acesso a nada. Para quem está no
   * teste da organização isso também não tira nada: `resolve()` devolve o
   * contexto mais permissivo entre conta e organização, e o trial segue por cima
   * até o pagamento entrar.
   */
  private async attachToAccount(input: {
    accountId: string;
    planId: string;
    stripeSubscriptionId: string;
  }): Promise<Subscription | null> {
    const plan = await this.plansRepository.findById(input.planId);

    if (!plan) {
      this.logger.error(
        `Checkout metadata points to unknown plan ${input.planId} for account ${input.accountId}`,
      );
      return null;
    }

    const existing = await this.subscriptionsRepository.findByAccountId(
      input.accountId,
    );

    if (existing) {
      existing.attachProviderSubscription({
        externalSubscriptionId: input.stripeSubscriptionId,
      });
      await this.subscriptionsRepository.update(existing);

      return existing;
    }

    const created = Subscription.createPendingPayment({
      accountId: input.accountId,
      planId: input.planId,
      billingProvider: 'STRIPE',
    });
    created.attachProviderSubscription({
      externalSubscriptionId: input.stripeSubscriptionId,
    });
    await this.subscriptionsRepository.save(created);

    return created;
  }

  /**
   * O checkout hospedado fechou.
   *
   * Só amarra conta ↔ assinatura da Stripe. A ativação continua sendo de
   * `invoice.paid`, que é quem tem a fatura, o valor e o cartão - duplicar a
   * ativação aqui criaria duas fontes para o mesmo fato.
   */
  private async handleCheckoutSessionCompleted(
    session: StripeCheckoutSessionRaw,
  ): Promise<void> {
    const stripeSubscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

    if (!stripeSubscriptionId) {
      // Checkout de pagamento avulso, não de assinatura. Nada a fazer.
      this.logger.debug('checkout.session.completed without subscription');
      return;
    }

    const accountId = session.metadata?.accountId;
    const planId = session.metadata?.planId;

    if (!accountId || !planId) {
      this.logger.warn(
        `checkout.session.completed for ${stripeSubscriptionId} has no account/plan metadata`,
      );
      return;
    }

    const subscription =
      await this.subscriptionsRepository.findByExternalSubscriptionId(
        stripeSubscriptionId,
      );

    if (subscription) return;

    await this.attachToAccount({ accountId, planId, stripeSubscriptionId });
  }

  private async handleInvoicePaid(invoice: StripeInvoiceRaw): Promise<void> {
    const stripeSubscriptionId = this.resolveStripeSubscriptionId(invoice);

    if (!stripeSubscriptionId) {
      this.logger.warn('invoice.paid received without subscription ID');
      return;
    }

    const resolved = await this.resolveLocalSubscription(stripeSubscriptionId);

    if (!resolved) {
      this.logger.warn(
        `Local subscription not found for Stripe subscription ${stripeSubscriptionId}`,
      );
      return;
    }

    const { subscription, purchasedPlanId } = resolved;

    const periodStart = invoice.period_start
      ? new Date(invoice.period_start * 1000)
      : new Date();
    const periodEnd = invoice.period_end
      ? new Date(invoice.period_end * 1000)
      : this.calculateNextMonthExpiration(periodStart);

    const amount = (invoice.amount_paid ?? 0) / 100;
    const currency = (invoice.currency ?? 'usd').toUpperCase();
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date();

    // charge ID: in the clover API it may be on invoice.charge or payment reference
    const chargeId: string | undefined =
      typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id;

    const resolvedInvoice = await this.resolveInvoice({
      subscriptionId: subscription.id,
      externalInvoiceId: invoice.id as string,
      amount,
      currency,
      periodStart,
      periodEnd,
      planId: subscription.planId,
      accountId: subscription.accountId,
    });

    resolvedInvoice.syncExternalInvoice({
      externalInvoiceId: invoice.id as string,
      amount,
      currency,
    });
    resolvedInvoice.updateStatus('PAID');

    const resolvedPayment = await this.resolvePayment({
      invoiceId: resolvedInvoice.id,
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
      amount,
      currency,
      externalPaymentId: chargeId,
    });

    resolvedPayment.updateFromProvider({
      status: 'APPROVED',
      externalPaymentId: chargeId,
      paymentMethod: 'CREDIT_CARD',
      paidAt,
    });

    /**
     * O plano que a Stripe cobrou tem precedência sobre o que estava gravado.
     *
     * Reusar `subscription.planId` só funciona quando a linha local já nasceu
     * com o plano certo - o que vale para `CreateSubscriptionUseCase`, mas não
     * para o Hosted Checkout, onde a compra acontece **fora** daqui e a linha
     * pode ser a de uma assinatura anterior. Sem esta preferência, quem sobe do
     * teste para o Profissional teria o pagamento do Profissional ativando o
     * plano velho, com a fatura certa e o acesso errado.
     *
     * Na renovação mensal os dois coincidem, então nada muda para quem já paga.
     */
    subscription.activatePaidPlan({
      planId: purchasedPlanId ?? subscription.planId,
      startedAt: paidAt,
      billingProvider: 'STRIPE',
      externalSubscriptionId: stripeSubscriptionId,
      nextBillingAt: periodEnd,
    });

    await this.saveOrUpdateInvoice(resolvedInvoice);
    await this.saveOrUpdatePayment(resolvedPayment);
    await this.subscriptionsRepository.update(subscription);

    /**
     * O cartão do checkout desce para o banco.
     *
     * Quem paga pelo Stripe.js confirma o PaymentIntent direto no Stripe — o
     * cartão nunca passa por aqui. É neste evento que o Stripe o promove a
     * `default_payment_method` da assinatura (`save_default_payment_method:
     * 'on_subscription'`), então é aqui que dá para lê-lo de volta. Sem esta
     * chamada, `billingCardId` ficava nulo para sempre e a tela de assinatura
     * dizia "Nenhum cartão cadastrado" a um assinante que é cobrado todo mês.
     *
     * Não derruba o webhook, pelo mesmo motivo do bloco de plano abaixo: fatura e
     * pagamento já foram gravados, e a leitura de `/billing/payment-method`
     * refaz esta sincronização sozinha se ela falhar aqui.
     */
    try {
      await this.syncSubscriptionBillingCard.execute(subscription);
    } catch (error) {
      this.logger.error(
        `Failed to sync billing card for subscription ${subscription.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    /**
     * O plano pago desce para a organização.
     *
     * A assinatura de conta é a verdade de cobrança; quem responde "qual é o
     * plano desta organização?" para as dezesseis guardas de
     * `ENFORCED_FEATURE_KEYS` é `organization_subscriptions`. A troca de plano
     * já propagava (`ChangeSubscriptionUseCase` → `AdAccountFreezeUseCase`), mas
     * a **primeira** assinatura não passa por lá — ela nasce `PENDING_PAYMENT` e
     * é este evento que a ativa. Sem esta linha a organização ficava no teste
     * FREE indefinidamente, e como o FREE espelha o PRO, quem assinou o
     * Individual recebia em silêncio o que o Profissional entrega.
     *
     * **Derruba o webhook**, e a mudança é deliberada. O `try/catch` que estava
     * aqui se justificava por "a reentrega seria tratada como duplicata" — o que
     * não é o que este código faz: `markProcessed` só roda depois do `switch`,
     * então um erro deixa `processedAt` nulo e a reentrega é **reprocessada**,
     * exatamente como o teste de retry documenta.
     *
     * A diferença importa porque a falha silenciosa era definitiva: log e
     * segue, evento marcado como processado, nenhuma reconciliação relendo isto
     * depois. O cliente pagava e ficava nas features do plano anterior, para
     * sempre. Deixando estourar, a Stripe reentrega até fechar — e a fatura e o
     * pagamento já gravados são idempotentes por id externo.
     */
    const propagated = await this.organizationPlan.syncPlanForOwner({
      ownerAccountId: subscription.accountId,
      planId: subscription.planId,
    });

    if (propagated === 0) {
      /**
       * Zero linhas é o mesmo estrago de uma exceção, só que mudo.
       *
       * `updateMany` não reclama quando não encontra nada, e sem organização
       * atualizada o cliente pagou e as guardas de feature seguem lendo o plano
       * anterior. Toda organização nasce com a linha em `saveWithOwner`, então
       * zero aqui é sintoma de dado inconsistente — e precisa aparecer.
       */
      this.logger.error(
        `Paid plan ${subscription.planId} reached no organization for account ${subscription.accountId}`,
      );
    }

    await this.auditLog.record({
      event: 'payment.succeeded',
      entityType: 'payment',
      entityId: resolvedPayment.id,
      metadata: {
        provider: 'STRIPE',
        accountId: subscription.accountId,
        subscriptionId: subscription.id,
        invoiceId: resolvedInvoice.id,
        amount,
        currency,
      },
    });

    await this.auditLog.record({
      event: 'subscription.activated',
      entityType: 'subscription',
      entityId: subscription.id,
      metadata: {
        provider: 'STRIPE',
        accountId: subscription.accountId,
        planId: subscription.planId,
        nextBillingAt: periodEnd.toISOString(),
      },
    });
  }

  private async handleInvoicePaymentFailed(
    invoice: StripeInvoiceRaw,
  ): Promise<void> {
    const stripeSubscriptionId = this.resolveStripeSubscriptionId(invoice);

    if (!stripeSubscriptionId) {
      this.logger.warn(
        'invoice.payment_failed received without subscription ID',
      );
      return;
    }

    const subscription =
      await this.subscriptionsRepository.findByExternalSubscriptionId(
        stripeSubscriptionId,
      );

    if (!subscription) {
      this.logger.warn(
        `Local subscription not found for Stripe subscription ${stripeSubscriptionId}`,
      );
      return;
    }

    const nextAttempt =
      typeof invoice.next_payment_attempt === 'number'
        ? new Date(invoice.next_payment_attempt * 1000)
        : undefined;

    subscription.markPastDue(nextAttempt);
    await this.subscriptionsRepository.update(subscription);

    await this.auditLog.record({
      event: 'payment.failed',
      entityType: 'subscription',
      entityId: subscription.id,
      metadata: {
        provider: 'STRIPE',
        accountId: subscription.accountId,
        externalInvoiceId: (invoice.id as string) ?? null,
        nextPaymentAttempt: nextAttempt?.toISOString() ?? null,
      },
    });

    await this.auditLog.record({
      event: 'subscription.past_due',
      entityType: 'subscription',
      entityId: subscription.id,
      metadata: {
        provider: 'STRIPE',
        accountId: subscription.accountId,
        gracePeriodEndsAt:
          subscription.gracePeriodEndsAt?.toISOString() ?? null,
      },
    });
  }

  private async handleSubscriptionUpdated(
    stripeSub: StripeSubscriptionRaw,
  ): Promise<void> {
    const subscription =
      await this.subscriptionsRepository.findByExternalSubscriptionId(
        stripeSub.id as string,
      );

    if (!subscription) {
      this.logger.warn(
        `Local subscription not found for Stripe subscription ${stripeSub.id}`,
      );
      return;
    }

    const status = this.stripeService.mapStripeSubscriptionStatus(
      stripeSub.status ?? '',
    ) as BillingStatus;

    /**
     * A Stripe moveu `current_period_end` para dentro de cada item; o topo
     * continua vindo em versões antigas. O que **não** serve é o
     * `billing_cycle_anchor` que estava aqui como terceira opção - ele é o
     * início do ciclo, e usá-lo como fim gravava uma "próxima cobrança" no
     * passado, que era o gatilho de `applyScheduledDowngradeIfDue()` logo
     * abaixo: todo downgrade agendado vencia no ato.
     */
    const currentPeriodEnd =
      stripeSub.items?.data?.[0]?.current_period_end ??
      stripeSub.current_period_end;

    subscription.syncWithProvider({
      status,
      nextBillingAt: currentPeriodEnd
        ? new Date(currentPeriodEnd * 1000)
        : undefined,
      canceledAt:
        typeof stripeSub.canceled_at === 'number'
          ? new Date(stripeSub.canceled_at * 1000)
          : undefined,
    });

    // A downgrade scheduled by `POST /billing/subscription/change` waits for the paid
    // period to end. Stripe renewing the subscription is that moment, so this is
    // where the cheaper plan finally takes effect locally.
    if (subscription.applyScheduledDowngradeIfDue()) {
      this.logger.log(
        `Applied scheduled downgrade for subscription ${subscription.id} → plan ${subscription.planId}`,
      );
    }

    await this.subscriptionsRepository.update(subscription);
  }

  private async handleSubscriptionDeleted(
    stripeSub: StripeSubscriptionRaw,
  ): Promise<void> {
    const subscription =
      await this.subscriptionsRepository.findByExternalSubscriptionId(
        stripeSub.id as string,
      );

    if (!subscription) {
      this.logger.warn(
        `Local subscription not found for Stripe subscription ${stripeSub.id}`,
      );
      return;
    }

    subscription.cancel();
    await this.subscriptionsRepository.update(subscription);

    /**
     * A organização cai junto — e é o outro lado de `syncPlanForOwner`.
     *
     * Sem isto o cancelamento só valia metade: a conta virava `CANCELED`, mas a
     * organização seguia `ACTIVE` com o plano pago gravado. Como `resolve()`
     * devolve o contexto mais permissivo dos dois, o produto continuava aberto
     * depois de a cobrança acabar, e as guardas de feature — que leem a
     * organização direto — seguiam entregando o plano pago de graça, sem prazo
     * para acabar.
     *
     * **Não engole erro**, ao contrário da propagação de plano: falhar aqui
     * deixa acesso pago aberto sem pagamento, e o certo é a Stripe reentregar o
     * evento até fechar. O cancelamento local já está gravado e a reentrega é
     * idempotente.
     */
    const revoked = await this.organizationPlan.revokeForOwner({
      ownerAccountId: subscription.accountId,
      status: 'CANCELED',
    });

    if (revoked === 0) {
      this.logger.warn(
        `Cancellation of subscription=${subscription.id} revoked no organization for account ${subscription.accountId}`,
      );
    }

    await this.auditLog.record({
      event: 'subscription.canceled',
      entityType: 'subscription',
      entityId: subscription.id,
      metadata: {
        provider: 'STRIPE',
        accountId: subscription.accountId,
        externalSubscriptionId: (stripeSub.id as string) ?? null,
        organizationsRevoked: revoked,
      },
    });
  }

  private async resolveInvoice(input: {
    subscriptionId: string;
    externalInvoiceId: string;
    amount: number;
    currency: string;
    periodStart: Date;
    periodEnd: Date;
    planId: string;
    accountId: string;
  }): Promise<Invoice> {
    const existing = await this.invoicesRepository.findByExternalInvoiceId(
      input.externalInvoiceId,
    );
    if (existing) return existing;

    const latest = await this.invoicesRepository.findLatestBySubscriptionId(
      input.subscriptionId,
    );

    if (latest && latest.status === 'PENDING' && !latest.externalInvoiceId) {
      return latest;
    }

    return Invoice.create({
      accountId: input.accountId,
      subscriptionId: input.subscriptionId,
      planId: input.planId,
      provider: 'STRIPE',
      number: this.generateInvoiceNumber(),
      amount: input.amount,
      currency: input.currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      externalInvoiceId: input.externalInvoiceId,
    });
  }

  private async resolvePayment(input: {
    invoiceId: string;
    subscriptionId: string;
    accountId: string;
    amount: number;
    currency: string;
    externalPaymentId?: string;
  }): Promise<Payment> {
    const existing =
      (input.externalPaymentId
        ? await this.paymentsRepository.findByExternalPaymentId(
            input.externalPaymentId,
          )
        : null) ??
      (await this.paymentsRepository.findByInvoiceId(input.invoiceId));

    if (existing) return existing;

    return Payment.create({
      accountId: input.accountId,
      subscriptionId: input.subscriptionId,
      invoiceId: input.invoiceId,
      provider: 'STRIPE',
      amount: input.amount,
      currency: input.currency,
      externalReference: `PAY-${input.invoiceId}`,
    });
  }

  private async saveOrUpdateInvoice(invoice: Invoice): Promise<void> {
    if (await this.invoicesRepository.findById(invoice.id)) {
      await this.invoicesRepository.update(invoice);
    } else {
      await this.invoicesRepository.save(invoice);
    }
  }

  private async saveOrUpdatePayment(payment: Payment): Promise<void> {
    if (await this.paymentsRepository.findById(payment.id)) {
      await this.paymentsRepository.update(payment);
    } else {
      await this.paymentsRepository.save(payment);
    }
  }

  private generateInvoiceNumber(): string {
    return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  private calculateNextMonthExpiration(startedAt: Date): Date {
    const year = startedAt.getUTCFullYear();
    const month = startedAt.getUTCMonth();
    const day = startedAt.getUTCDate();
    const lastDayOfNextMonth = new Date(
      Date.UTC(year, month + 2, 0),
    ).getUTCDate();
    const expirationDay = Math.min(day, lastDayOfNextMonth);
    return new Date(Date.UTC(year, month + 1, expirationDay));
  }
}
