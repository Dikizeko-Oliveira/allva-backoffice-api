import { SalesLead } from '../domain/entities';
import { SalesLeadOutputDto } from './dtos';

export function toSalesLeadOutput(lead: SalesLead): SalesLeadOutputDto {
  return {
    id: lead.id,
    accountId: lead.accountId,
    companyName: lead.companyName,
    workEmail: lead.workEmail,
    fullName: lead.fullName,
    phone: lead.phone,
    estimatedMonthlySpend: lead.estimatedMonthlySpend,
    teamSize: lead.teamSize,
    platforms: lead.platforms,
    notes: lead.notes,
    desiredPlan: lead.desiredPlan,
    status: lead.status,
    source: lead.source,
    assignedTo: lead.assignedTo,
    qualifiedAt: lead.qualifiedAt,
    closedWonAt: lead.closedWonAt,
    closedLostAt: lead.closedLostAt,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    provisionedOrganizationId: lead.provisionedOrganizationId,
  };
}
