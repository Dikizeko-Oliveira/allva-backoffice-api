import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ORGANIZATION_STATUSES } from 'src/modules/platform-admin/domain/organization-status';
import type {
  AdminAccountDetail,
  AdminAuditEventRow,
  AdminCustomerMembershipRow,
  AdminIntegrationRow,
  AdminInvoiceRow,
  AdminJobRunRow,
  AdminOperatorRow,
  AdminOrganizationDetail,
  AdminOrganizationRow,
  AdminSubscriptionRow,
  QuotaLine,
} from 'src/modules/platform-admin/domain/read-models';

/**
 * O contrato das leituras cross-org no Swagger.
 *
 * Cada classe `implements` o modelo de leitura do domínio: se o modelo ganhar
 * um campo, o compilador cobra a documentação — é o "método de port sem
 * chamador" que o gate de cobertura de resposta existe para evitar.
 */

class PersonRefDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
}

class OrganizationRefDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
}

class UsageAgainstLimitDto {
  @ApiProperty() used: number;
  @ApiProperty({ type: Number, nullable: true }) limit: number | null;
}

class QuotaLineDto implements QuotaLine {
  @ApiProperty({
    enum: ['seats', 'adAccounts', 'monitoredAds', 'organizations'],
  })
  dimension: QuotaLine['dimension'];
  @ApiProperty() used: number;
  @ApiProperty({ type: Number, nullable: true }) negotiated: number | null;
  @ApiProperty({ type: Number, nullable: true }) planCeiling: number | null;
  @ApiProperty({ type: Number, nullable: true }) effective: number | null;
}

export class AdminOrganizationDto implements AdminOrganizationRow {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) cnpj: string | null;
  @ApiProperty({ enum: ORGANIZATION_STATUSES })
  status: AdminOrganizationRow['status'];
  @ApiProperty({ type: String, nullable: true }) billingStatus: string | null;
  @ApiProperty({ type: String, nullable: true }) planType: string | null;
  @ApiProperty({ type: String, nullable: true }) planName: string | null;
  @ApiProperty({ type: String, nullable: true }) trialEndsAt: string | null;
  @ApiProperty({ enum: ['SELF_SERVICE', 'CONTRACT'] })
  origin: AdminOrganizationRow['origin'];
  @ApiProperty({ type: PersonRefDto }) owner: PersonRefDto;
  @ApiProperty() baseCurrency: string;
  @ApiProperty({ type: String, nullable: true }) currentContractId:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) salesLeadId: string | null;
  @ApiProperty({ type: [String] }) connectedPlatforms: string[];
  @ApiProperty({ type: UsageAgainstLimitDto }) seats: UsageAgainstLimitDto;
  @ApiProperty({ type: UsageAgainstLimitDto }) adAccounts: UsageAgainstLimitDto;
  @ApiProperty({ type: UsageAgainstLimitDto })
  monitoredAds: UsageAgainstLimitDto;
  @ApiProperty({ type: String, nullable: true }) lastSyncAt: string | null;
  @ApiProperty() createdAt: string;
}

class MembersSummaryDto {
  @ApiProperty() active: number;
  @ApiProperty() pendingInvitations: number;
}

export class AdminOrganizationDetailDto
  extends AdminOrganizationDto
  implements AdminOrganizationDetail
{
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ type: String, nullable: true }) address: string | null;
  @ApiProperty({ type: String, nullable: true }) addressNumber: string | null;
  @ApiProperty({ type: String, nullable: true })
  addressComplement: string | null;
  @ApiProperty({ type: String, nullable: true }) addressCity: string | null;
  @ApiProperty({ type: String, nullable: true }) nameConfirmedAt: string | null;
  @ApiProperty({ type: String, nullable: true }) accessClosedAt: string | null;
  @ApiProperty({ type: MembersSummaryDto }) members: MembersSummaryDto;
  @ApiProperty({ type: [QuotaLineDto] }) quotas: QuotaLineDto[];
}

export class AdminCustomerDto implements AdminCustomerMembershipRow {
  @ApiProperty() membershipId: string;
  @ApiProperty() accountId: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty({ enum: ['ACTIVE', 'INVITED', 'BLOCKED', 'REMOVED'] })
  status: string;
  @ApiProperty({ type: OrganizationRefDto }) organization: OrganizationRefDto;
  @ApiProperty() organizationRole: string;
  @ApiProperty({ type: String, nullable: true }) planType: string | null;
  @ApiProperty({ type: String, nullable: true }) lastSeenAt: string | null;
  @ApiProperty() createdAt: string;
}

export class AdminOperatorDto implements AdminOperatorRow {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty() platformRole: string;
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] })
  status: 'ACTIVE' | 'DISABLED';
  @ApiProperty({ type: String, nullable: true }) lastSeenAt: string | null;
  @ApiProperty() createdAt: string;
}

class AccountMembershipDto {
  @ApiProperty() membershipId: string;
  @ApiProperty({ type: OrganizationRefDto }) organization: OrganizationRefDto;
  @ApiProperty() role: string;
  @ApiProperty() status: string;
  @ApiProperty() createdAt: string;
}

export class AdminAccountDetailDto implements AdminAccountDetail {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() email: string;
  @ApiProperty() emailVerified: boolean;
  @ApiProperty({ type: String, nullable: true }) platformRole: string | null;
  @ApiProperty({ type: String, nullable: true }) cpf: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ type: String, nullable: true }) address: string | null;
  @ApiProperty({ type: String, nullable: true }) addressNumber: string | null;
  @ApiProperty({ type: String, nullable: true })
  addressComplement: string | null;
  @ApiProperty({ type: String, nullable: true }) addressCity: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl: string | null;
  @ApiProperty({ type: String, nullable: true }) lastSeenAt: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty({ type: [AccountMembershipDto] })
  memberships: AccountMembershipDto[];
}

export class AdminSubscriptionDto implements AdminSubscriptionRow {
  @ApiProperty() id: string;
  @ApiProperty({ type: OrganizationRefDto }) organization: OrganizationRefDto;
  @ApiProperty({ enum: ORGANIZATION_STATUSES })
  status: AdminSubscriptionRow['status'];
  @ApiProperty() billingStatus: string;
  @ApiProperty() planType: string;
  @ApiProperty() planName: string;
  @ApiProperty({ enum: ['SELF_SERVICE', 'CONTRACT'] })
  source: AdminSubscriptionRow['source'];
  @ApiProperty({ type: String, nullable: true }) contractId: string | null;
  @ApiProperty({ type: String, nullable: true }) contractNumber: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Contrato que governa (anual ÷ 12) ou preço de tabela do plano. Não é receita reconhecida.',
  })
  monthlyAmount: number | null;
  @ApiProperty() currency: string;
  @ApiProperty({ type: String, nullable: true }) trialEndsAt: string | null;
  @ApiProperty({ type: String, nullable: true }) pendingPlanType: string | null;
  @ApiProperty({ type: String, nullable: true })
  pendingPlanEffectiveAt: string | null;
  @ApiProperty() startedAt: string;
}

class ContractRefDto {
  @ApiProperty() id: string;
  @ApiProperty() contractNumber: string;
}

export class AdminInvoiceDto implements AdminInvoiceRow {
  @ApiProperty() id: string;
  @ApiProperty() number: string;
  @ApiProperty({ enum: ['PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED'] })
  status: string;
  @ApiProperty({ description: '`PENDING` com vencimento no passado.' })
  overdue: boolean;
  @ApiProperty() amount: number;
  @ApiProperty() currency: string;
  @ApiProperty() provider: string;
  @ApiProperty({ type: String, nullable: true })
  externalInvoiceId: string | null;
  @ApiProperty() periodStart: string;
  @ApiProperty() periodEnd: string;
  @ApiProperty({ type: String, nullable: true }) dueAt: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty({ type: OrganizationRefDto, nullable: true })
  organization: OrganizationRefDto | null;
  @ApiProperty({ type: ContractRefDto, nullable: true })
  contract: ContractRefDto | null;
  @ApiProperty({ type: PersonRefDto }) account: PersonRefDto;
}

class IntegrationAdAccountDto {
  @ApiProperty() id: string;
  @ApiProperty() platform: string;
  @ApiProperty() externalAccountId: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['HEALTHY', 'DEGRADED', 'UNREACHABLE'] })
  syncHealth: string;
  @ApiProperty({ type: String, nullable: true })
  syncHealthReason: string | null;
  @ApiProperty({ type: String, nullable: true })
  lastSuccessfulFullSyncAt: string | null;
}

export class AdminIntegrationDto implements AdminIntegrationRow {
  @ApiProperty() id: string;
  @ApiProperty({ type: OrganizationRefDto }) organization: OrganizationRefDto;
  @ApiProperty() provider: string;
  @ApiProperty() providerType: string;
  @ApiProperty({ type: String, nullable: true }) name: string | null;
  @ApiProperty({
    enum: ['CONNECTED', 'DISCONNECTED', 'TOKEN_EXPIRED', 'ERROR'],
  })
  status: string;
  @ApiProperty({ enum: ['IDLE', 'SYNCING', 'SUCCESS', 'FAILED'] })
  syncStatus: string;
  @ApiProperty({ type: String, nullable: true }) syncError: string | null;
  @ApiProperty({ type: String, nullable: true }) lastSyncAt: string | null;
  @ApiProperty() expiresAt: string;
  @ApiProperty({ type: String, nullable: true }) disconnectedAt: string | null;
  @ApiProperty({ type: PersonRefDto }) connectedBy: PersonRefDto;
  @ApiProperty() createdAt: string;
  @ApiProperty({ type: [IntegrationAdAccountDto] })
  adAccounts: IntegrationAdAccountDto[];
}

export class AdminJobRunDto implements AdminJobRunRow {
  @ApiProperty() id: string;
  @ApiProperty() jobName: string;
  @ApiProperty({
    enum: ['AD_ACCOUNT', 'ORGANIZATION', 'INTEGRATION', 'GLOBAL'],
  })
  scopeType: string;
  @ApiProperty() scopeId: string;
  @ApiProperty({ type: OrganizationRefDto, nullable: true })
  organization: OrganizationRefDto | null;
  @ApiProperty() windowKey: string;
  @ApiProperty({ enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] })
  status: string;
  @ApiProperty({ description: '`RUNNING` com lease vencido.' })
  stalled: boolean;
  @ApiProperty() attempt: number;
  @ApiProperty() startedAt: string;
  @ApiProperty({ type: String, nullable: true }) finishedAt: string | null;
  @ApiProperty({ type: Number, nullable: true }) durationMs: number | null;
  @ApiProperty() processedItems: number;
  @ApiProperty() successfulItems: number;
  @ApiProperty() failedItems: number;
  @ApiProperty({ type: String, nullable: true }) errorMessage: string | null;
  @ApiProperty({ type: String, nullable: true }) skipReason: string | null;
}

export class AdminAuditEventDto implements AdminAuditEventRow {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['BUSINESS', 'SECURITY'] })
  kind: AdminAuditEventRow['kind'];
  @ApiProperty({ example: 'organization.quota.updated' }) event: string;
  @ApiProperty({ enum: ['INFO', 'WARNING', 'CRITICAL'] })
  severity: AdminAuditEventRow['severity'];
  @ApiProperty({ type: PersonRefDto, nullable: true })
  actor: PersonRefDto | null;
  @ApiProperty({ type: OrganizationRefDto, nullable: true })
  organization: OrganizationRefDto | null;
  @ApiProperty({ type: String, nullable: true }) entityType: string | null;
  @ApiProperty({ type: String, nullable: true }) entityId: string | null;
  @ApiProperty({ type: String, nullable: true }) ipAddress: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) metadata: unknown;
  @ApiProperty() occurredAt: string;
}

/** Envelope de página das listas administrativas — o de `ListContractsOutputDto`. */
function pageOf<T>(item: new () => T) {
  class PageDto {
    @ApiProperty({ type: [item] }) items: T[];
    @ApiProperty() total: number;
    @ApiProperty() page: number;
    @ApiProperty() pageSize: number;
  }
  return PageDto;
}

export class AdminOrganizationsPageDto extends pageOf(AdminOrganizationDto) {}
export class AdminCustomersPageDto extends pageOf(AdminCustomerDto) {}
export class AdminOperatorsPageDto extends pageOf(AdminOperatorDto) {}
export class AdminSubscriptionsPageDto extends pageOf(AdminSubscriptionDto) {}
export class AdminInvoicesPageDto extends pageOf(AdminInvoiceDto) {}
export class AdminIntegrationsPageDto extends pageOf(AdminIntegrationDto) {}
export class AdminAuditEventsPageDto extends pageOf(AdminAuditEventDto) {}

export class AdminJobRunsPageDto extends pageOf(AdminJobRunDto) {
  @ApiProperty({
    type: [String],
    description: 'Os nomes de job que já rodaram — o que o filtro oferece.',
  })
  jobNames: string[];
}

class OverviewMetricDto {
  @ApiProperty({ example: 'orgs.active' }) key: string;
  @ApiProperty({ example: 'orgs:read' }) permission: string;
  @ApiProperty({ enum: ['COUNT', 'MONEY'] }) unit: 'COUNT' | 'MONEY';
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`null` = indisponível agora, não zero.',
  })
  value: number | null;
  @ApiPropertyOptional({ example: 'BRL' }) currency?: string;
}

export class AdminOverviewDto {
  @ApiProperty() generatedAt: string;
  @ApiProperty({ type: [OverviewMetricDto] }) metrics: OverviewMetricDto[];
}
