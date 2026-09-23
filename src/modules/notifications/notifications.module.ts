import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { PlansModule } from 'src/modules/plans/plans.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { Module } from '@nestjs/common';
import { DailySummaryService } from './application/services/daily-summary.service';
import { DailySummaryScheduler } from './infrastructure/schedulers/daily-summary.scheduler';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';
import { DatabaseModule } from 'src/shared/infrastructure/database/database.module';

@Module({
  imports: [
    EmailModule,
    DatabaseModule,
    // `DailySummaryService` resolve a organização da conta (Integrations), a
    // cadência do plano dela (Plans) e se ela ainda tem acesso aberto
    // (SubscriptionAccess) antes de enviar.
    IntegrationsModule,
    PlansModule,
    SubscriptionAccessModule,
  ],
  providers: [DailySummaryService, DailySummaryScheduler],
})
export class NotificationsModule {}
