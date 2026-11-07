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
import { AlertRuleEvaluatorService } from './application/services/alert-rule-evaluator.service';
import { AlertEvaluationScheduler } from './infrastructure/jobs/alert-evaluation.scheduler';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';
import { AttentionCountsPrismaReader } from 'src/modules/operations-hub/infrastructure/database/prisma/attention-counts-prisma.reader';
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
    AlertRuleEvaluatorService,
    AlertEvaluationScheduler,
    // As mesmas contagens do hub: o alerta dispara pelo número que o operador
    // vê, nunca por uma segunda leitura que possa divergir dele.
    {
      provide: AttentionCountsReaderInterface,
      useClass: AttentionCountsPrismaReader,
    },
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
