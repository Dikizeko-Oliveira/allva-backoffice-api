import type { PlatformPermission } from 'src/modules/accounts/domain/platform-rbac';
import type { OrganizationStatus } from './organization-status';

/**
 * Os modelos de leitura do painel de operador — **cross-org**.
 *
 * Tudo aqui é leitura. Nenhuma escrita passa por este módulo: ativar contrato,
 * dar baixa em fatura, mudar status de chamado continuam nos módulos donos do
 * dado (`contracts`, `support`, `sales-leads`…), onde a invariante mora.
 *
 * Os campos são os que o banco tem, com o nome que o banco dá. O backoffice
 * nasceu com tipos inventados enquanto estes endpoints não existiam (fatura
 * `OVERDUE`/`VOID`, integração por conta de anúncio, MRR por organização), e é
 * ele que se ajusta a isto — não o contrário. Um campo derivado só entra quando
 * a derivação é regra de negócio que não deve morar na tela (o estado da
 * organização, o teto efetivo de cota, a fatura vencida).
 */

export type PageRequest = { page: number; pageSize: number };

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type PersonRef = { id: string; name: string; email: string };
export type OrganizationRef = { id: string; name: string };

// ─── Organizações ────────────────────────────────────────────────────────────

export type QuotaDimension =
  | 'seats'
  | 'adAccounts'
  | 'monitoredAds'
  | 'organizations';

/** `limit: null` = sem teto numérico resolvível (sem plano, por exemplo). */
export type UsageAgainstLimit = { used: number; limit: number | null };

export type QuotaLine = {
  dimension: QuotaDimension;
  used: number;
  /** Teto negociado (`organization_quotas`). `null` herda o plano. */
  negotiated: number | null;
  planCeiling: number | null;
  /** O que vale: `negotiated ?? planCeiling`. */
  effective: number | null;
};

export type AdminOrganizationRow = {
  id: string;
  name: string;
  cnpj: string | null;
  status: OrganizationStatus;
  /** O valor cru de `organization_subscriptions.status`, para quem precisar. */
  billingStatus: string | null;
  planType: string | null;
  planName: string | null;
  trialEndsAt: string | null;
  /** `CONTRACT` quando a organização tem ao menos um contrato Enterprise. */
  origin: 'SELF_SERVICE' | 'CONTRACT';
  owner: PersonRef;
  baseCurrency: string;
  /** O contrato que governa agora (vigente, senão o próximo, senão o último). */
  currentContractId: string | null;
  salesLeadId: string | null;
  /** Provedores com credencial `CONNECTED`. */
  connectedPlatforms: string[];
  seats: UsageAgainstLimit;
  adAccounts: UsageAgainstLimit;
  monitoredAds: UsageAgainstLimit;
  lastSyncAt: string | null;
  createdAt: string;
};

export type AdminOrganizationDetail = AdminOrganizationRow & {
  phone: string | null;
  address: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressCity: string | null;
  nameConfirmedAt: string | null;
  accessClosedAt: string | null;
  members: { active: number; pendingInvitations: number };
  quotas: QuotaLine[];
};

export type AdminOrganizationFilters = PageRequest & {
  q?: string;
  status?: OrganizationStatus;
  plan?: string;
};

// ─── Contas ──────────────────────────────────────────────────────────────────

/**
 * Um cliente **numa organização** — a linha é a participação, não a conta.
 *
 * A mesma pessoa em duas organizações aparece duas vezes, com papel e estado
 * de cada uma. É a pergunta que a tela de Usuários faz ("quem está bloqueado
 * na organização X"), e a conta sozinha não a responde.
 */
export type AdminCustomerMembershipRow = {
  membershipId: string;
  accountId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  status: string;
  organization: OrganizationRef;
  organizationRole: string;
  planType: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

export type AdminCustomerFilters = PageRequest & {
  q?: string;
  status?: string;
  organizationId?: string;
  plan?: string;
};

export type AdminOperatorRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  platformRole: string;
  status: 'ACTIVE' | 'DISABLED';
  lastSeenAt: string | null;
  createdAt: string;
};

export type AdminOperatorFilters = PageRequest & {
  q?: string;
  status?: 'ACTIVE' | 'DISABLED';
  platformRole?: string;
  /** Só papéis que têm esta permissão — "quem pode assumir um chamado". */
  permission?: PlatformPermission;
};

export type AdminAccountDetail = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  platformRole: string | null;
  cpf: string | null;
  phone: string | null;
  address: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressCity: string | null;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  memberships: {
    membershipId: string;
    organization: OrganizationRef;
    role: string;
    status: string;
    createdAt: string;
  }[];
};

// ─── Assinaturas e faturas ───────────────────────────────────────────────────

export type AdminSubscriptionRow = {
  id: string;
  organization: OrganizationRef;
  status: OrganizationStatus;
  billingStatus: string;
  planType: string;
  planName: string;
  source: 'SELF_SERVICE' | 'CONTRACT';
  contractId: string | null;
  contractNumber: string | null;
  /**
   * Valor recorrente por mês: do contrato que governa (anual ÷ 12), ou o
   * preço de tabela do plano no autoatendimento. Não é receita reconhecida.
   */
  monthlyAmount: number | null;
  currency: string;
  trialEndsAt: string | null;
  pendingPlanType: string | null;
  pendingPlanEffectiveAt: string | null;
  startedAt: string;
};

export type AdminSubscriptionFilters = PageRequest & {
  q?: string;
  status?: OrganizationStatus;
  plan?: string;
};

export type AdminInvoiceRow = {
  id: string;
  number: string;
  status: string;
  /** `PENDING` com vencimento no passado. */
  overdue: boolean;
  amount: number;
  currency: string;
  provider: string;
  externalInvoiceId: string | null;
  periodStart: string;
  periodEnd: string;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
  organization: OrganizationRef | null;
  contract: { id: string; contractNumber: string } | null;
  account: PersonRef;
};

export type AdminInvoiceFilters = PageRequest & {
  q?: string;
  status?: string;
  overdue?: boolean;
  organizationId?: string;
};

// ─── Plataforma ──────────────────────────────────────────────────────────────

export type AdminIntegrationRow = {
  id: string;
  organization: OrganizationRef;
  provider: string;
  providerType: string;
  name: string | null;
  status: string;
  syncStatus: string;
  syncError: string | null;
  lastSyncAt: string | null;
  expiresAt: string;
  disconnectedAt: string | null;
  connectedBy: PersonRef;
  createdAt: string;
  adAccounts: {
    id: string;
    platform: string;
    externalAccountId: string;
    name: string;
    syncHealth: string;
    syncHealthReason: string | null;
    lastSuccessfulFullSyncAt: string | null;
  }[];
};

export type AdminIntegrationFilters = PageRequest & {
  q?: string;
  provider?: string;
  status?: string;
  organizationId?: string;
};

export type AdminJobRunRow = {
  id: string;
  jobName: string;
  scopeType: string;
  scopeId: string;
  organization: OrganizationRef | null;
  windowKey: string;
  status: string;
  /** `RUNNING` com lease vencido — o worker morreu segurando a janela. */
  stalled: boolean;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  processedItems: number;
  successfulItems: number;
  failedItems: number;
  errorMessage: string | null;
  skipReason: string | null;
};

export type AdminJobRunFilters = PageRequest & {
  status?: string;
  jobName?: string;
  stalled?: boolean;
  from?: Date;
  to?: Date;
};

// ─── Auditoria ───────────────────────────────────────────────────────────────

export type AuditKind = 'BUSINESS' | 'SECURITY';
export type AuditSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export type AdminAuditEventRow = {
  id: string;
  kind: AuditKind;
  event: string;
  severity: AuditSeverity;
  actor: PersonRef | null;
  organization: OrganizationRef | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  occurredAt: string;
};

export type AdminAuditFilters = PageRequest & {
  kind?: AuditKind;
  severity?: AuditSeverity;
  q?: string;
  organizationId?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
};

// ─── Overview ────────────────────────────────────────────────────────────────

export type OverviewMetricKey =
  | 'orgs.total'
  | 'orgs.active'
  | 'orgs.trialing'
  | 'orgs.past_due'
  | 'billing.monthly_recurring'
  | 'billing.overdue_amount'
  | 'support.tickets_open'
  | 'leads.new_30d'
  | 'contacts.new_7d'
  | 'integrations.connected'
  | 'integrations.unhealthy'
  | 'operations.job_runs_failed_24h';
