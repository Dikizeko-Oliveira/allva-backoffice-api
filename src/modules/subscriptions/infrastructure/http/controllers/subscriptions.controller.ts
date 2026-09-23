import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import {
  CreateSubscriptionInputDto,
  DowngradeSubscriptionInputDto,
} from 'src/modules/subscriptions/application/dtos';
import {
  CancelSubscriptionUseCase,
  CreateSubscriptionUseCase,
  DowngradeSubscriptionUseCase,
  GetSubscriptionClientSecretUseCase,
  ListSubscriptionsUseCase,
} from 'src/modules/subscriptions/application/use-cases';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { AllowFreeTrial } from 'src/modules/subscriptions/access/infrastructure/http/decorators/allow-free-trial.decorator';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import { DeprecatedEndpoint } from 'src/shared/infrastructure/http/deprecated-endpoint.decorator';

@ApiTags('Gerenciar Assinaturas')
@Controller('/api/v1/subscriptions')
@UseGuards(EntitlementGuard)
export class SubscriptionsController {
  constructor(
    private readonly createSubscriptionUseCase: CreateSubscriptionUseCase,
    private readonly downgradeSubscriptionUseCase: DowngradeSubscriptionUseCase,
    private readonly cancelSubscriptionUseCase: CancelSubscriptionUseCase,
    private readonly listSubscriptionsUseCase: ListSubscriptionsUseCase,
    private readonly getSubscriptionClientSecretUseCase: GetSubscriptionClientSecretUseCase,
  ) {}

  @Post()
  @RequireAccessStatuses(
    'GRACE_PERIOD',
    'PAYMENT_REQUIRED',
    'PENDING_ACTIVATION',
    'BLOCKED',
  )
  // Esta é a porta de contratação da **primeira** assinatura, e quem está no
  // teste gratuito é exatamente quem ainda precisa passar por ela. Sem isto o
  // teste (`ALLOWED`) era recusado com `INVALID_SUBSCRIPTION_STATE` e mandado
  // para a troca de plano, que por sua vez o recusava por não haver assinatura
  // de conta para trocar.
  @AllowFreeTrial()
  @ApiOperation({ summary: 'Criar assinatura' })
  @ApiOkResponse({
    description: 'Fluxo de assinatura iniciado com sucesso',
    schema: {
      example: {
        id: 'uuid-subscription-id',
        accountId: 'uuid-account-id',
        planId: 'uuid-plan-id',
        planType: 'PRO',
        status: 'PENDING_PAYMENT',
        billingProvider: 'STRIPE',
      },
    },
  })
  async createSubscription(
    @CurrentUser() user: Account,
    @Body() dto: CreateSubscriptionInputDto,
  ) {
    const accountId = user.id;
    return this.createSubscriptionUseCase.execute(accountId, dto);
  }

  @Post('/downgrade')
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @DeprecatedEndpoint({
    replacedBy: 'POST /api/v1/billing/subscription/change',
    note:
      'A rota canônica cobre upgrade e downgrade e é a única que fala com o Stripe. ' +
      'Esta aqui apenas troca o `planId` local e de imediato: o assinante passa a ' +
      'ser cobrado o preço antigo por um plano menor, e perde no ato o acesso ao ' +
      'período que já pagou. Mesma classe de divergência que o Sprint 6 corrigiu no ' +
      'cancelamento. O canônico agenda o downgrade para o fim do período (`effect: ' +
      'AT_PERIOD_END`) e recebe `planId` (UUID) em vez de `planType`.',
  })
  @ApiOkResponse({
    description: 'Downgrade realizado com sucesso',
    schema: { example: {} },
  })
  @ApiBadRequestResponse({
    description: 'Transição de plano inválida para downgrade',
    schema: {
      example: {
        code: 'INVALID_DOWNGRADE_TARGET',
        message: 'Target plan must be lower than current plan',
      },
    },
  })
  async downgradeSubscription(
    @CurrentUser() user: Account,
    @Body() dto: DowngradeSubscriptionInputDto,
  ) {
    const accountId = user.id;
    return this.downgradeSubscriptionUseCase.execute(accountId, dto);
  }

  @Delete('/cancel')
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @DeprecatedEndpoint({
    replacedBy: 'DELETE /api/v1/payments/stripe/cancel',
    note:
      'Cancelamento agora é resolvido pelo use case, que fala com o provedor certo. ' +
      'Antes do Sprint 6 esta rota devolvia 200 sem cancelar nada para assinantes Stripe.',
  })
  @ApiOkResponse({
    description: 'Assinatura cancelada com sucesso',
    schema: { example: {} },
  })
  @ApiBadRequestResponse({
    description: 'Assinatura ausente ou já cancelada',
    schema: {
      example: {
        code: 'SUBSCRIPTION_ALREADY_CANCELED',
        message: 'Subscription is already canceled',
      },
    },
  })
  async cancelSubscription(@CurrentUser() user: Account) {
    const accountId = user.id;
    await this.cancelSubscriptionUseCase.execute(accountId);
    return {};
  }

  @Get('/client-secret')
  @RequireAccessStatuses(
    'PAYMENT_REQUIRED',
    'PENDING_ACTIVATION',
    'GRACE_PERIOD',
  )
  // Retomar o pagamento de quem está no teste gratuito. O acesso dele é
  // `ALLOWED` (o teste corre), mas a assinatura paga que ele começou está em
  // `INCOMPLETE` esperando cartão - sem isto, recarregar a tela de checkout
  // durante o teste tornava impossível concluir a compra.
  @AllowFreeTrial()
  @ApiOperation({
    summary:
      'Obter client secret de assinatura Stripe incompleta para retomada de pagamento',
  })
  @ApiOkResponse({
    description: 'Client secret recuperado com sucesso',
    schema: {
      example: {
        subscriptionId: 'uuid-subscription-id',
        planId: 'uuid-plan-id',
        billingStatus: 'INCOMPLETE',
        provider: 'STRIPE',
        clientSecret: 'pi_xxx_secret_xxx',
      },
    },
  })
  async getClientSecret(@CurrentUser() user: Account) {
    const accountId = user.id;
    return this.getSubscriptionClientSecretUseCase.execute(accountId);
  }

  @Get()
  @AuthenticatedOnly()
  @DeprecatedEndpoint({
    replacedBy: 'GET /api/v1/billing/subscription',
    note: 'Chama exatamente o mesmo use case, com o mesmo argumento e a mesma resposta.',
  })
  async listSubscriptions(@CurrentUser() user: Account) {
    const accountId = user.id;
    return this.listSubscriptionsUseCase.execute(accountId);
  }
}
