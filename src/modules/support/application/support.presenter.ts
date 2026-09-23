import type { SlaPolicy, TicketSlaSnapshot } from '../domain/entities';
import type { ProductSupportTicket } from '../domain/ports';
import type { SlaPolicyOutputDto, SupportTicketOutputDto } from './dtos';

export function toSupportTicketOutput(
  ticket: ProductSupportTicket,
  snapshot: TicketSlaSnapshot,
  now: Date,
): SupportTicketOutputDto {
  return {
    ...ticket.payload,
    sla: snapshot.slaView(now),
    escalation: {
      escalatedAt: snapshot.escalatedAt,
      escalatedTo: snapshot.escalatedTo,
    },
  };
}

export function toSlaPolicyOutput(policy: SlaPolicy): SlaPolicyOutputDto {
  return {
    id: policy.id,
    priority: policy.priority,
    category: policy.category,
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    businessHours: policy.businessHours,
    active: policy.active,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}
