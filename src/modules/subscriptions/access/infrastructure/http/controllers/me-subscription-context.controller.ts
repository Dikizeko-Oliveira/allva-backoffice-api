import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import { SubscriptionContextResolver } from 'src/modules/subscriptions/access/application/subscription-context.resolver';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';

@ApiTags('Acesso e Entitlement')
@ApiBearerAuth()
@Controller('/api/v1/me')
@UseGuards(EntitlementGuard)
export class MeSubscriptionContextController {
  constructor(private readonly resolver: SubscriptionContextResolver) {}

  @Get('subscription-context')
  @AuthenticatedOnly()
  @ApiOperation({
    summary:
      'Retorna o contexto canônico de assinatura/entitlement do usuário (somente leitura local).',
  })
  @ApiOkResponse({
    description: 'Contexto canônico do usuário autenticado',
    schema: {
      example: {
        provider: 'STRIPE',
        billingStatus: 'ACTIVE',
        accessStatus: 'ALLOWED',
        planId: 'uuid-plan-id',
        planName: 'PRO',
        planType: 'PRO',
        subscriptionId: 'uuid-subscription-id',
        expiresAt: '2026-12-01T00:00:00.000Z',
        gracePeriodEndsAt: null,
        canAccessProduct: true,
        canAccessSubscriptionsPage: false,
        canAccessBillingPage: true,
        redirectPath: null,
        reasonCode: 'ACCESS_ALLOWED',
        scope: 'ORGANIZATION',
        organizationId: 'uuid-organization-id',
      },
    },
  })
  async getContext(@CurrentUser() user: Account) {
    return this.resolver.resolve(user.id);
  }
}
