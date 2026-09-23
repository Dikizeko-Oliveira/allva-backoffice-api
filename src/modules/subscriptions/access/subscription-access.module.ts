import { Module } from '@nestjs/common';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { SubscriptionContextResolver } from 'src/modules/subscriptions/access/application/subscription-context.resolver';
import { MeSubscriptionContextController } from 'src/modules/subscriptions/access/infrastructure/http/controllers/me-subscription-context.controller';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { SubscriptionsPrismaRepository } from 'src/modules/subscriptions/infrastructure/database/prisma/subscription-prisma.repository';
import { OrganizationEntitlementRepositoryInterface } from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';
import { OrganizationSweepRepositoryInterface } from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import { OrganizationEntitlementPrismaRepository } from 'src/modules/subscriptions/access/infrastructure/database/prisma/organization-entitlement-prisma.repository';
import { OrganizationSweepPrismaRepository } from 'src/modules/subscriptions/access/infrastructure/database/prisma/organization-sweep-prisma.repository';

@Module({
  controllers: [MeSubscriptionContextController],
  providers: [
    SubscriptionContextResolver,
    EntitlementGuard,
    OrganizationSweepPolicyService,
    {
      provide: SubscriptionsRepositoryInterface,
      useClass: SubscriptionsPrismaRepository,
    },
    {
      provide: OrganizationEntitlementRepositoryInterface,
      useClass: OrganizationEntitlementPrismaRepository,
    },
    {
      provide: OrganizationSweepRepositoryInterface,
      useClass: OrganizationSweepPrismaRepository,
    },
  ],
  exports: [
    SubscriptionContextResolver,
    EntitlementGuard,
    OrganizationEntitlementRepositoryInterface,
    // Os schedulers de todo módulo com job perguntam aqui quem varrer.
    OrganizationSweepPolicyService,
  ],
})
export class SubscriptionAccessModule {}
