import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { PreferencesModule } from 'src/modules/preferences/preferences.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { DatabaseModule } from 'src/shared/infrastructure/database/database.module';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';
import { AlertNotifierService } from './application/services/alert-notifier.service';
import { AlertRecipientResolver } from './application/services/alert-recipient.resolver';
import {
  CreateAlertUseCase,
  DismissAlertUseCase,
  GetAlertUseCase,
  ListAlertsUseCase,
  MarkAlertReadUseCase,
  MarkAllAlertsReadUseCase,
  ResolveAlertUseCase,
} from './application/use-cases/alert-use-cases';
import { AlertsRepositoryInterface } from './domain/ports/alerts.repository';
import { AlertsPrismaRepository } from './infrastructure/database/prisma/alerts-prisma.repository';
import { AlertsController } from './infrastructure/http/controllers/alerts.controller';
import { ActionAlertListener } from './infrastructure/events/action-alert.listener';
import { SyncAlertListener } from './infrastructure/events/sync-alert.listener';
import { WasteAlertListener } from './infrastructure/events/waste-alert.listener';
import { ALERTS_QUEUE } from './infrastructure/queues/alerts.constants';
import { AlertsDispatcher } from './infrastructure/queues/alerts.dispatcher';
import { AlertsWorker } from './infrastructure/queues/alerts.worker';

@Module({
  imports: [
    // `AlertNotifierService` corta email de desperdício por severidade.
    PlansModule,
    SubscriptionAccessModule,
    IntegrationsModule,
    // Sprint 6 / M-2 — alert delivery needs the mail sender, the account lookup for
    // the recipient, and the preference gate that decides whether it may send.
    EmailModule,
    DatabaseModule,
    PreferencesModule,
    // A2-S3: `alerts` passa a ser **consumidor de evento puro** (§5.3 r.7). O
    // listener só enfileira (⊕10); a fila é o que impede a latência do e-mail de
    // entrar no caminho do ingest, já que `EventEmitter2` é síncrono.
    BullModule.registerQueue({ name: ALERTS_QUEUE }),
  ],
  controllers: [AlertsController],
  providers: [
    CreateAlertUseCase,
    ListAlertsUseCase,
    GetAlertUseCase,
    MarkAlertReadUseCase,
    MarkAllAlertsReadUseCase,
    DismissAlertUseCase,
    ResolveAlertUseCase,
    AlertNotifierService,
    AlertRecipientResolver,
    SyncAlertListener,
    // A2-S5: os dois sujeitos que o v1 não conseguia preencher — `WASTE_ITEM`
    // (alerta órfão do detector antigo) e o `AD` do drift de denormalização.
    WasteAlertListener,
    // Escrita que criou entidade e não terminou — crítico quando pode veicular.
    ActionAlertListener,
    AlertsDispatcher,
    AlertsWorker,
    { provide: AlertsRepositoryInterface, useClass: AlertsPrismaRepository },
  ],
  exports: [CreateAlertUseCase],
})
export class AlertsModule {}
