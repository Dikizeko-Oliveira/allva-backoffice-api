import { BadRequestException, Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { TicketAssignmentEvent } from 'src/modules/support/domain/entities';
import {
  SupportTicketsGatewayInterface,
  TicketAssignmentEventsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { AssignSupportTicketInputDto, SupportTicketOutputDto } from '../dtos';
import { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';

export type RequestOrigin = {
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Atribui (ou desatribui) um chamado.
 *
 * O responsável é gravado **no produto** — é lá que a tela do cliente e as
 * notificações o leem. Aqui fica o que é processo interno: o repasse com
 * motivo, o SLA atualizado e a auditoria.
 *
 * Repassar um chamado que já tinha dono exige motivo. Assumir um chamado
 * livre, ou reatribuir ao mesmo operador, não.
 */
@Injectable()
export class AssignSupportTicketUseCase {
  constructor(
    private readonly ticketsGateway: SupportTicketsGatewayInterface,
    private readonly assignmentEventsRepository: TicketAssignmentEventsRepositoryInterface,
    private readonly slaTracker: TicketSlaTrackerService,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    ticketId: string,
    input: AssignSupportTicketInputDto,
    origin: RequestOrigin = {},
  ): Promise<SupportTicketOutputDto> {
    assertPlatformPermission(operator, 'support:manage');

    const toOperatorId = input.toOperatorId ?? null;
    const reason = input.reason?.trim() || null;

    const before = await this.ticketsGateway.get(operator, ticketId);
    const fromOperatorId = before.facts.assigneeId;

    if (fromOperatorId && fromOperatorId !== toOperatorId && !reason) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_REASON_REQUIRED',
        message: 'Reason is required when reassigning a ticket',
        field: 'reason',
      });
    }

    const updated = await this.ticketsGateway.assign(
      operator,
      ticketId,
      toOperatorId,
    );

    await this.assignmentEventsRepository.save(
      TicketAssignmentEvent.create({
        ticketId,
        fromOperatorId,
        toOperatorId,
        actorId: operator.id,
        reason,
      }),
    );

    const [output] = await this.slaTracker.track([updated]);

    await this.audit.record({
      actor: operator,
      action: 'support.ticket.assigned',
      subjectType: 'SUPPORT_TICKET',
      subjectId: ticketId,
      before: { assigneeId: fromOperatorId },
      after: { assigneeId: toOperatorId },
      reason,
      ip: origin.ip,
      userAgent: origin.userAgent,
    });

    return output;
  }
}
