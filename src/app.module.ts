import { MiddlewareConsumer, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuditModule } from './modules/audit/audit.module';
import { BackofficeAuthGuard } from './modules/auth/backoffice-auth.guard';
import { BackofficeAuthModule } from './modules/auth/backoffice-auth.module';
import { PlatformPermissionGuard } from './modules/auth/platform-permission.guard';
import { BackofficeCommonModule } from './modules/common/backoffice-common.module';
import { ContractDraftsModule } from './modules/contracts/contract-drafts.module';
import { HubModule } from './modules/hub/hub.module';
import { NotesModule } from './modules/notes/notes.module';
import { OperatorPreferencesModule } from './modules/preferences/operator-preferences.module';
import { ProductApiModule } from './modules/product/product-api.module';
import { SupportOperationsModule } from './modules/support/support-operations.module';
import { CorrelationIdMiddleware } from './shared/infrastructure/context/correlation-id.middleware';
import { RequestContextModule } from './shared/infrastructure/context/request-context.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';

@Module({
  imports: [
    RequestContextModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    ProductApiModule,
    BackofficeAuthModule,
    BackofficeCommonModule,
    HubModule,
    SupportOperationsModule,
    NotesModule,
    OperatorPreferencesModule,
    AlertsModule,
    ContractDraftsModule,
    AuditModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: BackofficeAuthGuard },
    { provide: APP_GUARD, useClass: PlatformPermissionGuard },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
