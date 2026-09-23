import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SupportTicketsGatewayInterface } from 'src/modules/support/domain/ports';
import { SupportTicketOutputDto } from '../dtos';
import { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';

@Injectable()
export class GetSupportTicketUseCase {
  constructor(
    private readonly ticketsGateway: SupportTicketsGatewayInterface,
    private readonly slaTracker: TicketSlaTrackerService,
  ) {}

  async execute(
    operator: Operator,
    ticketId: string,
  ): Promise<SupportTicketOutputDto> {
    assertPlatformPermission(operator, 'support:read');

    const ticket = await this.ticketsGateway.get(operator, ticketId);
    const [output] = await this.slaTracker.track([ticket]);

    return output;
  }
}
