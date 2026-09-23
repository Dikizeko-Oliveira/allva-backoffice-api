import type {
  AdminAccountDetail,
  AdminAuditEventRow,
  AdminAuditFilters,
  AdminCustomerFilters,
  AdminCustomerMembershipRow,
  AdminIntegrationFilters,
  AdminIntegrationRow,
  AdminInvoiceFilters,
  AdminInvoiceRow,
  AdminJobRunFilters,
  AdminJobRunRow,
  AdminOperatorFilters,
  AdminOperatorRow,
  AdminOrganizationDetail,
  AdminOrganizationFilters,
  AdminOrganizationRow,
  AdminSubscriptionFilters,
  AdminSubscriptionRow,
  OverviewMetricKey,
  Page,
} from '../read-models';

/**
 * As leituras cross-org do painel de operador, uma porta por área.
 *
 * Separadas por área, e não uma porta só, pela mesma razão das telas: quem
 * mexe em faturas não deveria precisar entender a consulta de auditoria.
 */
export abstract class AdminOrganizationsReaderInterface {
  abstract list(
    filters: AdminOrganizationFilters,
  ): Promise<Page<AdminOrganizationRow>>;
  abstract findById(id: string): Promise<AdminOrganizationDetail | null>;
}

export abstract class AdminAccountsReaderInterface {
  abstract listCustomers(
    filters: AdminCustomerFilters,
  ): Promise<Page<AdminCustomerMembershipRow>>;
  /** `roles` já vem resolvido da permissão pedida — ver o use case. */
  abstract listOperators(
    filters: AdminOperatorFilters & { roles?: readonly string[] },
  ): Promise<Page<AdminOperatorRow>>;
  abstract findById(id: string): Promise<AdminAccountDetail | null>;
}

export abstract class AdminBillingReaderInterface {
  abstract listSubscriptions(
    filters: AdminSubscriptionFilters,
  ): Promise<Page<AdminSubscriptionRow>>;
  abstract listInvoices(
    filters: AdminInvoiceFilters,
    now: Date,
  ): Promise<Page<AdminInvoiceRow>>;
}

export abstract class AdminPlatformReaderInterface {
  abstract listIntegrations(
    filters: AdminIntegrationFilters,
  ): Promise<Page<AdminIntegrationRow>>;
  abstract listJobRuns(
    filters: AdminJobRunFilters,
    now: Date,
  ): Promise<Page<AdminJobRunRow>>;
  abstract listJobNames(): Promise<string[]>;
}

export abstract class AdminAuditReaderInterface {
  abstract list(filters: AdminAuditFilters): Promise<Page<AdminAuditEventRow>>;
}

export abstract class AdminOverviewReaderInterface {
  /** Como no hub: só as pedidas, e uma falha some da resposta sem derrubar as outras. */
  abstract compute(
    keys: readonly OverviewMetricKey[],
    now: Date,
  ): Promise<Partial<Record<OverviewMetricKey, number>>>;
}
