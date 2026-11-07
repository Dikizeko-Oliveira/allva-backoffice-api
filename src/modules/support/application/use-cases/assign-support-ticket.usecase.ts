import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

/**
 * Atribui (ou desatribui) um chamado.
 *
 * O responsável é gravado **no produto** — é lá que a tela do cliente e as
 * notificações o leem. Aqui fica o que é processo interno: o repasse com
 * motivo, o SLA atualizado e a auditoria.
 *
 * Repassar um chamado que já tinha dono exige motivo. Assumir um chamado
 * livre, ou reatribuir ao mesmo operador, não.
 *
 * O motivo é decidido sobre o responsável lido **antes** do `assign`; se ele
 * mudou nesse intervalo, o produto não tem como recusar — falta a ele uma
 * atribuição condicional ao responsável esperado (GAP-045, parte em aberto).
 */
@Injectable()
export class AssignSupportTicketUseCase {
  private readonly logger = new Logger(AssignSupportTicketUseCase.name);

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

    // A atribuição já valeu no produto. A auditoria vem primeiro porque nunca
    // falha a operação e guarda de → para e o motivo: se a gravação local
    // seguinte cair, é ela (e o log abaixo) o rastro recuperável (GAP-045).
    await this.audit.record({
      actor: operator,
      action: 'support.ticket.assigned',
      subjectType: 'SUPPORT_TICKET',
      subjectId: ticketId,
      before: { assigneeId: fromOperatorId },
      after: { assigneeId: toOperatorId },
      reason,
    });

    try {
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
      return output;
    } catch (error) {
      this.logger.error(
        `support.assignment_local_write_failed ticketId=${ticketId} from=${fromOperatorId ?? '-'} to=${toOperatorId ?? '-'} actorId=${operator.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
