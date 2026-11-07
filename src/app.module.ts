import { MiddlewareConsumer, Module } from '@nestjs/common';
import { AlertsModule } from './modules/alerts/alerts.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContractDraftsModule } from './modules/contract-drafts/contract-drafts.module';
import { HealthModule } from './modules/health/health.module';
import { InternalNotesModule } from './modules/internal-notes/internal-notes.module';
import { OperationsHubModule } from './modules/operations-hub/operations-hub.module';
import { PreferencesModule } from './modules/preferences/preferences.module';
import { SupportModule } from './modules/support/support.module';
import { AllvaApiModule } from './shared/infrastructure/allva-api/allva-api.module';
import { EnvModule } from './shared/infrastructure/config/env.module';
import { CorrelationIdMiddleware } from './shared/infrastructure/context/correlation-id.middleware';
import { AccessLogMiddleware } from './shared/infrastructure/context/access-log.middleware';
import { RequestContextModule } from './shared/infrastructure/context/request-context.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';

@Module({
  imports: [
    EnvModule,
    RequestContextModule,
    DatabaseModule,
    AllvaApiModule,
    AuditModule,
    AuthModule,
    HealthModule,
    OperationsHubModule,
    SupportModule,
    InternalNotesModule,
    PreferencesModule,
    AlertsModule,
    ContractDraftsModule,
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    // AccessLogMiddleware logo depois: toda requisição deixa uma linha com o id
    // que o CorrelationIdMiddleware acabou de fixar (GAP-058).
    consumer.apply(CorrelationIdMiddleware, AccessLogMiddleware).forRoutes('*');
  }
}
