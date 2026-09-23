import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Account } from 'src/modules/accounts/domain/entities';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { assertSelfServePlan } from 'src/modules/plans/application/assert-self-serve-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { Subscription } from 'src/modules/subscriptions/domain/entities';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { mapBillingToAccess } from 'src/modules/subscriptions/access/domain/access-status';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { CreateSubscriptionInputDto } from '../dtos/create-subscription.dto';

/**
 * Janela do teste quando o plano FREE nao declara `trialDays`.
 *
 * O valor anterior era 36500 — cem anos, ou seja, uma camada gratuita perpetua
 * reinstalada por engano no dia em que alguem salvasse o plano sem o campo. O
 * FREE **e** o teste: fechada a janela, a conta contrata um plano pago.
 */
const FREE_TRIAL_DAYS = 14;

/**
 * A colisão de chave única do Prisma (`P2002`).
 *
 * Comparada pelo código e não pela classe: importar `Prisma.PrismaClientKnownRequestError`
 * amarraria esta camada de aplicação ao cliente gerado, que é exatamente a
 * dependência que os repositórios existem para conter.
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class CreateSubscriptionUseCase {
  private readonly logger = new Logger(CreateSubscriptionUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly stripeService: StripeService,
  ) {}

  async execute(accountId: string, input: CreateSubscriptionInputDto) {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const existingSubscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (existingSubscription) {
      const accessStatus =
        existingSubscription.accessStatus ??
        mapBillingToAccess(existingSubscription.billingStatus);

      if (accessStatus === 'ALLOWED') {
        throw new ConflictException({
          code: 'SUBSCRIPTION_ALREADY_ACTIVE',
          message: 'Account already has an active subscription',
          accessStatus,
          billingStatus: existingSubscription.billingStatus,
          redirectTo: '/account/billing',
        });
      }

      if (
        existingSubscription.billingStatus !== 'CANCELED' &&
        existingSubscription.billingStatus !== 'EXPIRED'
      ) {
        throw new ConflictException({
          code: 'SUBSCRIPTION_ALREADY_EXISTS',
          message: 'Account already has a subscription flow in progress',
          accessStatus,
          billingStatus: existingSubscription.billingStatus,
        });
      }
    }

    const targetPlanId = input.planId ?? account.selectedPlanId;

    if (!targetPlanId) {
      throw new BadRequestException({
        code: 'PLAN_NOT_SELECTED',
        message: 'Account has no selected plan',
      });
    }

    const plan = await this.plansRepository.findById(targetPlanId);

    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not found',
      });
    }

    // O Enterprise não passa por aqui: ele nasce de um lead `CLOSED_WON`, que
    // provisiona organização, assentos e cotas negociadas de uma vez.
    assertSelfServePlan(plan.type);

    if (existingSubscription) {
      throw new ConflictException({
        code: 'SUBSCRIPTION_RECREATE_NOT_SUPPORTED',
        message: 'Recreating a canceled subscription is not supported yet',
      });
    }

    // Stripe is the product's billing provider; an omitted `billingProvider` used to
    // silently create a Mercado Pago subscription instead.
    const billingProvider = input.billingProvider ?? 'STRIPE';

    const subscription =
      plan.type === 'FREE'
        ? Subscription.createFree({
            accountId,
            planId: plan.id,
            trialDays: plan.trialDays ?? FREE_TRIAL_DAYS,
          })
        : Subscription.createPendingPayment({
            accountId,
            planId: plan.id,
            billingProvider,
            externalReference: `sub:${accountId}:${Date.now()}`,
          });

    /**
     * A linha local é gravada **antes** da Stripe — e a ordem é o conserto.
     *
     * Era o contrário: criava a assinatura na Stripe e só então inseria aqui.
     * `subscriptions.account_id` é único, então duas chamadas simultâneas — o
     * checkout monta duas vezes quando a pessoa recarrega ou o guard a devolve
     * para a mesma tela — passavam as duas pela verificação de "já existe",
     * criavam **duas assinaturas e dois clientes na Stripe**, e só a segunda
     * inserção estourava. Resultado: o cliente ficava com duas cobranças de
     * R$ 497 abertas no provedor e uma só registrada aqui, invisível para o
     * produto e para o suporte.
     *
     * Reservando a vaga primeiro, quem perde a corrida perde **antes** de gastar
     * qualquer coisa na Stripe: a violação de unicidade vira o mesmo `409` que a
     * verificação já devolvia, e a tela retoma o pagamento que a outra chamada
     * começou.
     */
    await this.reserveSubscriptionSlot(subscription);

    if (plan.type === 'FREE') {
      return this.toOutput(subscription, plan.type, null);
    }

    try {
      return await this.linkToProvider(account, subscription, plan);
    } catch (error) {
      /**
       * A reserva só vale enquanto a ligação com a Stripe está em curso.
       *
       * Mantê-la depois de a Stripe recusar deixaria a conta com uma assinatura
       * `PENDING_PAYMENT` sem contraparte no provedor: `POST /subscriptions`
       * recusaria por já existir uma, e `GET /client-secret` não teria o que
       * devolver. Ninguém consegue pagar, e nada limpa isso sozinho. Devolvendo
       * a vaga, a próxima tentativa começa do zero.
       */
      await this.subscriptionsRepository
        .deleteById(subscription.id)
        .catch((cleanupError) => {
          this.logger.error(
            `Failed to release reserved subscription ${subscription.id}: ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`,
          );
        });

      throw error;
    }
  }

  /**
   * Grava a linha local traduzindo a colisão de unicidade para o mesmo conflito
   * que a verificação prévia produz.
   *
   * Sem esta tradução, o perdedor da corrida recebia `500` com o erro cru do
   * Prisma — caminho de arquivo do servidor incluído — e a tela mostrava "Algo
   * deu errado". Com ela, o front reconhece `SUBSCRIPTION_ALREADY_EXISTS` e
   * retoma o pagamento em vez de oferecer um "Tentar novamente" que falha igual.
   */
  private async reserveSubscriptionSlot(
    subscription: Subscription,
  ): Promise<void> {
    try {
      await this.subscriptionsRepository.save(subscription);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;

      throw new ConflictException({
        code: 'SUBSCRIPTION_ALREADY_EXISTS',
        message: 'Account already has a subscription flow in progress',
      });
    }
  }

  /** Cria a contraparte na Stripe para uma linha já reservada e a persiste. */
  private async linkToProvider(
    account: Account,
    subscription: Subscription,
    plan: { type: string; amount: number | null; name: string; stripePriceId: string | null },
  ) {
    const clientSecret = await this.handleStripeSubscription(
      account,
      plan,
      subscription,
    );

    await this.subscriptionsRepository.update(subscription);

    return this.toOutput(subscription, plan.type, clientSecret);
  }

  private toOutput(
    subscription: Subscription,
    planType: string,
    clientSecret: string | null,
  ) {
    return {
      id: subscription.id,
      subscriptionId: subscription.id,
      accountId: subscription.accountId,
      planId: subscription.planId,
      planType,
      billingStatus: subscription.billingStatus,
      status: subscription.billingStatus,
      clientSecret,
      provider: subscription.billingProvider ?? null,
      billingProvider: subscription.billingProvider ?? null,
      ...(subscription.billingProvider === 'STRIPE' &&
      subscription.externalSubscriptionId
        ? { stripeSubscriptionId: subscription.externalSubscriptionId }
        : {}),
      authorizationUrl: subscription.authorizationUrl,
      nextBillingAt: subscription.nextBillingAt,
    };
  }

  private async handleStripeSubscription(
    account: {
      id: string;
      email: string;
      name: string;
      stripeCustomerId?: string;
    },
    plan: {
      type: string;
      amount: number | null;
      name: string;
      stripePriceId: string | null;
    },
    subscription: Subscription,
  ): Promise<string> {
    this.logger.log(
      `[Stripe] Starting paid subscription for planType=${plan.type} ` +
        `planAmount=${plan.amount} stripePriceId=${plan.stripePriceId ?? 'null'}`,
    );

    if (!plan.amount || plan.amount <= 0) {
      throw new InternalServerErrorException({
        code: 'PLAN_AMOUNT_NOT_CONFIGURED',
        message: 'Paid plan amount is not configured or is zero',
      });
    }

    const stripePriceId = plan.stripePriceId;

    if (!stripePriceId) {
      throw new InternalServerErrorException({
        code: 'STRIPE_PRICE_NOT_CONFIGURED',
        message: `Stripe price not configured for plan ${plan.type}`,
      });
    }

    if (!stripePriceId.startsWith('price_')) {
      throw new InternalServerErrorException({
        code: 'STRIPE_PRICE_INVALID_FORMAT',
        message:
          `stripePriceId "${stripePriceId}" is invalid. ` +
          `Expected a Stripe Price ID starting with "price_". ` +
          `Product IDs (prod_) and other values are not accepted.`,
      });
    }

    // Validate price in Stripe before creating the subscription.
    // Guards against misconfigured prices (inactive, one-time, zero-amount, wrong mode).
    await this.stripeService.validateStripePrice(stripePriceId);

    const { stripeCustomerId } = await this.stripeService.ensureStripeCustomer({
      existingStripeCustomerId: account.stripeCustomerId,
      email: account.email,
      name: account.name,
      accountId: account.id,
    });

    if (!account.stripeCustomerId) {
      await this.accountsRepository.attachStripeCustomer(
        account.id,
        stripeCustomerId,
      );
    }

    const providerSubscription =
      await this.stripeService.createStripeSubscription({
        stripeCustomerId,
        stripePriceId,
        internalSubscriptionId: subscription.id,
      });

    this.logger.log(
      `[Stripe] Subscription created sub=${providerSubscription.externalSubscriptionId} ` +
        `status=${providerSubscription.status} hasClientSecret=true`,
    );

    // Attach the Stripe subscription ID but keep billingStatus as PENDING_PAYMENT.
    // Status is promoted to ACTIVE only after webhook invoice.paid is received.
    subscription.attachProviderSubscription({
      externalSubscriptionId: providerSubscription.externalSubscriptionId,
      nextBillingAt: providerSubscription.currentPeriodEnd,
    });

    return providerSubscription.clientSecret;
  }
}
