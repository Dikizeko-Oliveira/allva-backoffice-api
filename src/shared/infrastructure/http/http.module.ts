import { Module } from '@nestjs/common';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { AlertsModule } from 'src/modules/alerts/alerts.module';
import { AnalyticsModule } from 'src/modules/analytics/analytics.module';
import { AuditModule } from 'src/modules/audit/audit.module';
import { AuthModule } from 'src/modules/auth/auth.module';
import { BillingModule } from 'src/modules/billing/billing.module';
import { AdsModule } from 'src/modules/ads/ads.module';
import { AdScoringModule } from 'src/modules/ad-scoring/ad-scoring.module';
import { ContactsModule } from 'src/modules/contacts/contacts.module';
import { CurrencyModule } from 'src/modules/currency/currency.module';
import { CreativeLabModule } from 'src/modules/creative-lab/creative-lab.module';
import { DevToolsModule } from 'src/modules/dev-tools/dev-tools.module';
import { HealthModule } from 'src/modules/health/health.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { InvoicesModule } from 'src/modules/invoices/invoices.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { OperationsHubModule } from 'src/modules/operations-hub/operations-hub.module';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { PaymentsModule } from 'src/modules/subscriptions/payments.module';
import { AnalysisScopeModule } from 'src/modules/analysis-scope/analysis-scope.module';
import { OnboardingChainModule } from 'src/modules/onboarding-chain/onboarding-chain.module';
import { PaywallModule } from 'src/modules/paywall/paywall.module';
import { PlatformAdminModule } from 'src/modules/platform-admin/platform-admin.module';
import { PlatformClientsModule } from 'src/modules/platform-clients/platform-clients.module';
import { PlansModule } from 'src/modules/plans/plans.module';
import { PreferencesModule } from 'src/modules/preferences/preferences.module';
import { PlatformActionsModule } from 'src/modules/platform-actions/platform-actions.module';
import { RecommendationsModule } from 'src/modules/recommendations/recommendations.module';
import { ReportsModule } from 'src/modules/reports/reports.module';
import { ContractsModule } from 'src/modules/contracts/contracts.module';
import { SalesLeadsModule } from 'src/modules/sales-leads/sales-leads.module';
import { SecurityModule } from 'src/modules/security/security.module';
import { SubscriptionsModule } from 'src/modules/subscriptions/subscriptions.module';
import { SupportModule } from 'src/modules/support/support.module';
import { SyncModule } from 'src/modules/sync/sync.module';
import { UploadModule } from 'src/modules/upload/upload.module';
import { WasteModule } from 'src/modules/waste/waste.module';

@Module({
  imports: [
    AccountsModule,
    AlertsModule,
    AuditModule,
    SecurityModule,
    AuthModule,
    BillingModule,
    AdsModule,
    AdScoringModule,
    SyncModule,
    CurrencyModule,
    PlatformClientsModule,
    HealthModule,
    IntegrationsModule,
    InvoicesModule,
    NotificationsModule,
    OrganizationsModule,
    PlansModule,
    PreferencesModule,
    SubscriptionsModule,
    UploadModule,
    PaymentsModule,
    AnalyticsModule,
    WasteModule,
    RecommendationsModule,
    AnalysisScopeModule,
    OnboardingChainModule,
    PaywallModule,
    PlatformActionsModule,
    CreativeLabModule,
    ReportsModule,
    SalesLeadsModule,
    ContractsModule,
    ContactsModule,
    SupportModule,
    OperationsHubModule,
    PlatformAdminModule,
    DevToolsModule,
  ],
  exports: [
    AccountsModule,
    AlertsModule,
    AuthModule,
    BillingModule,
    AdsModule,
    AdScoringModule,
    SyncModule,
    CurrencyModule,
    PlatformClientsModule,
    HealthModule,
    IntegrationsModule,
    InvoicesModule,
    NotificationsModule,
    OrganizationsModule,
    PlansModule,
    PreferencesModule,
    SubscriptionsModule,
    UploadModule,
    PaymentsModule,
    AnalyticsModule,
    WasteModule,
    RecommendationsModule,
    AnalysisScopeModule,
    PaywallModule,
    PlatformActionsModule,
    CreativeLabModule,
    ReportsModule,
    SalesLeadsModule,
    ContractsModule,
    ContactsModule,
  ],
})
export class HttpModule {}
