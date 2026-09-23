import { Module } from '@nestjs/common';
import {
  AcknowledgeAlertEventUseCase,
  CreateAlertRuleUseCase,
  ListAlertEventsUseCase,
  ListAlertRulesUseCase,
  UpdateAlertRuleUseCase,
} from './application/use-cases';
import {
  AlertEventsRepositoryInterface,
  AlertRulesRepositoryInterface,
} from './domain/ports';
import { AlertEventsPrismaRepository } from './infrastructure/database/prisma/alert-events-prisma.repository';
import { AlertRulesPrismaRepository } from './infrastructure/database/prisma/alert-rules-prisma.repository';
import { AlertEventsController } from './infrastructure/http/controllers/alert-events.controller';
import { AlertRulesController } from './infrastructure/http/controllers/alert-rules.controller';

@Module({
  controllers: [AlertRulesController, AlertEventsController],
  providers: [
    ListAlertRulesUseCase,
    CreateAlertRuleUseCase,
    UpdateAlertRuleUseCase,
    ListAlertEventsUseCase,
    AcknowledgeAlertEventUseCase,
    {
      provide: AlertRulesRepositoryInterface,
      useClass: AlertRulesPrismaRepository,
    },
    {
      provide: AlertEventsRepositoryInterface,
      useClass: AlertEventsPrismaRepository,
    },
  ],
})
export class AlertsModule {}
