import { MiddlewareConsumer, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SecurityContextMiddleware } from './modules/security/infrastructure/http/security-context.middleware';
import { AuditModule } from './backoffice/audit/audit.module';
import { BackofficeAuthGuard } from './backoffice/auth/backoffice-auth.guard';
import { BackofficeAuthModule } from './backoffice/auth/backoffice-auth.module';
import { PlatformPermissionGuard } from './backoffice/auth/platform-permission.guard';
import { AlertsModule } from './backoffice/alerts/alerts.module';
import { BackofficeCommonModule } from './backoffice/common/backoffice-common.module';
import { ContractDraftsModule } from './backoffice/contracts/contract-drafts.module';
import { HubModule } from './backoffice/hub/hub.module';
import { NotesModule } from './backoffice/notes/notes.module';
import { OperatorPreferencesModule } from './backoffice/preferences/operator-preferences.module';
import { ProductApiModule } from './backoffice/product/product-api.module';
import { SupportOperationsModule } from './backoffice/support/support-operations.module';
import { CorrelationIdMiddleware } from './shared/infrastructure/context/correlation-id.middleware';
import { RequestContextModule } from './shared/infrastructure/context/request-context.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { SecurityModule } from './shared/infrastructure/security/security.module';

@Module({
  imports: [
    RequestContextModule,
    SecurityModule,
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
    consumer
      .apply(CorrelationIdMiddleware, SecurityContextMiddleware)
      .forRoutes('*');
  }
}
