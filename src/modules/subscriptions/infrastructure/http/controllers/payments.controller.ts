import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  Logger,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { NoThrottle } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { Account } from 'src/modules/accounts/domain/entities';
import { assertSelfServePlan } from 'src/modules/plans/application/assert-self-serve-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { CancelSubscriptionUseCase } from 'src/modules/subscriptions/application/use-cases';
import { HandleStripeWebhookUseCase } from 'src/modules/subscriptions/application/use-cases/handle-stripe-webhook.usecase';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import type { StripeEvent } from '../../services/stripe.types';
import { getStripeClient } from '../../services/stripe.client';
import {
  CancelSubscriptionOutputDto,
  CreateCheckoutInputDto,
  CreateCheckoutOutputDto,
} from '../dtos';
import { StripeService } from '../../services/stripe.service';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';

@ApiTags('Gerenciar Pagamentos e Assinaturas')
@Controller('/api/v1/payments/stripe')
@UseGuards(EntitlementGuard)
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly cancelSubscriptionUseCase: CancelSubscriptionUseCase,
    private readonly handleStripeWebhookUseCase: HandleStripeWebhookUseCase,
    private readonly env: EnvService,
    private readonly appUrl: AppUrlService,
  ) {}

  @Post('webhook')
  @Public()
  /**
   * Never rate limited, under any policy.
   *
   * Stripe owns the subscription lifecycle — payments, renewals, cancellations,
   * expiry, upgrades and downgrades all reach this process as webhook events, in
   * provider-IP bursts that share no identity with any user. Throttling here does
   * not shed load, it drops lifecycle transitions: a 429 makes Stripe retry with
   * backoff and, once retries are exhausted, the event is lost and local billing
   * state silently diverges from the provider's.
   *
   * Authenticity comes from the signature check below, not from a request budget.
   */
  @NoThrottle()
  @ApiExcludeEndpoint()
  async handleWebhook(
    @Req() req,
    @Headers('stripe-signature') signature: string,
  ) {
    let event: StripeEvent;

    // Read through EnvService so the value is the validated one. The previous
    // `String(process.env.STRIPE_WEBHOOK_SECRET)` turned an unset secret into the
    // literal string "undefined", which fails verification anyway — safe, but it
    // reported a signature mismatch instead of a misconfiguration, and bypassed
    // the schema entirely.
    const webhookSecret = this.env.get('STRIPE_WEBHOOK_SECRET');

    if (!webhookSecret?.trim()) {
      // Fail closed and say why. The boot guard makes this unreachable in
      // production; outside it, this is the honest diagnosis.
      this.logger.error(
        'Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured',
      );
      throw new BadRequestException({
        code: 'STRIPE_WEBHOOK_SECRET_MISSING',
        message: 'Webhook signature cannot be verified',
      });
    }

    try {
      event = getStripeClient().webhooks.constructEvent(
        req.rawBody,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.logger.warn(
        `Stripe webhook signature verification failed: ${error instanceof Error ? error.message : error}`,
      );
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    await this.handleStripeWebhookUseCase.execute(event);

    return { received: true };
  }

  /**
   * `ALLOWED` entra na lista, e é o ponto do upgrade.
   *
   * Sem ele, quem está **no teste gratuito** não tinha por onde contratar: a
   * organização nasce com o trial provisionado, o acesso fica `ALLOWED`, e as
   * três portas de contratação (`POST /subscriptions`,
   * `GET /subscriptions/client-secret` e este checkout) exigiam justamente o
   * contrário — algum estado de acesso degradado. O resultado era um ciclo
   * fechado: quem quisesse pagar durante o teste recebia
   * `INVALID_SUBSCRIPTION_STATE` em toda tentativa, e só conseguia assinar
   * depois que o trial expirasse e o produto fechasse na cara dele.
   *
   * As outras duas continuam fechadas de propósito - elas criam a **primeira**
   * assinatura pressupondo que não existe nenhuma. O Hosted Checkout não
   * pressupõe: ele cria a assinatura na Stripe e o webhook casa com o que
   * houver aqui, que é o caminho certo para quem já tem um estado comercial
   * em curso.
   */
  @Post('checkout')
  @RequireAccessStatuses(
    'ALLOWED',
    'GRACE_PERIOD',
    'PAYMENT_REQUIRED',
    'PENDING_ACTIVATION',
    'BLOCKED',
  )
  @ApiOperation({ summary: 'Criar checkout Stripe para upgrade de plano' })
  @ApiOkResponse({
    description: 'Checkout criado com sucesso',
    type: CreateCheckoutOutputDto,
  })
  @ApiBadRequestResponse({
    description: 'Plano inválido ou dados inconsistentes',
    schema: {
      example: {
        code: 'INVALID_PLAN',
        message: 'Plan type is invalid',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Usuário não autenticado',
  })
  async checkout(
    @CurrentUser() user: Account,
    @Body() body: CreateCheckoutInputDto,
  ) {
    const plan = await this.plansRepository.findByType(body.planType);

    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: `Plan ${body.planType} not found`,
      });
    }

    // Terceira porta para a mesma cobrança indevida: o checkout hospedado da
    // Stripe chegaria ao mesmo lugar por fora das outras duas guardas.
    assertSelfServePlan(plan.type);

    if (!plan.stripePriceId) {
      throw new BadRequestException({
        code: 'STRIPE_PRICE_NOT_CONFIGURED',
        message: `Stripe price not configured for plan ${body.planType}`,
      });
    }

    return this.stripeService.createCheckout({
      accountId: user.id,
      planId: plan.id,
      stripeCustomerId: user.stripeCustomerId,
      stripePriceId: plan.stripePriceId,
      successUrl: this.appUrl.pathTo('plans/subscriptions/success'),
      cancelUrl: this.appUrl.pathTo('plans/subscriptions/cancel'),
    });
  }

  @Post('setup-intent')
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD', 'PAYMENT_REQUIRED')
  @ApiOperation({
    summary: 'Criar Stripe SetupIntent para atualizar método de pagamento',
  })
  @ApiOkResponse({
    description: 'SetupIntent criado com sucesso',
    schema: { example: { clientSecret: 'seti_..._secret_...' } },
  })
  @ApiUnauthorizedResponse({ description: 'Usuário não autenticado' })
  async createSetupIntent(@CurrentUser() user: Account) {
    if (!user.stripeCustomerId) {
      const { stripeCustomerId } =
        await this.stripeService.ensureStripeCustomer({
          email: user.email,
          name: user.name,
          accountId: user.id,
        });

      return this.stripeService.createSetupIntent(stripeCustomerId);
    }

    return this.stripeService.createSetupIntent(user.stripeCustomerId);
  }

  @Delete('cancel')
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({ summary: 'Cancelar assinatura ativa no Stripe' })
  @ApiOkResponse({
    description: 'Assinatura cancelada com sucesso',
    type: CancelSubscriptionOutputDto,
  })
  @ApiConflictResponse({
    description: 'Conta não possui assinatura ativa',
    schema: {
      example: {
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: 'No active subscription found',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Usuário não autenticado',
  })
  async cancel(
    @CurrentUser() user: Account,
  ): Promise<CancelSubscriptionOutputDto> {
    const accountId = user.id;

    // The provider call moved into the use case (M-3), so this endpoint and
    // `DELETE /subscriptions/cancel` can no longer drift apart — they previously
    // did, and the other one silently cancelled nothing for Stripe subscribers.
    await this.cancelSubscriptionUseCase.execute(accountId);

    return { canceled: true };
  }
}
