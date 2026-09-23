import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { Operator } from 'src/modules/auth/domain/entities';
import type {
  ProductSupportTicket,
  SupportTicketsGatewayInterface,
  TicketAssignmentEventsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import type { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';
import { AssignSupportTicketUseCase } from './assign-support-ticket.usecase';

const operator = (permissions = ['support:read', 'support:manage']) =>
  Operator.restore({
    id: 'op-1',
    name: 'Ana',
    email: 'ana@allva.com',
    platformRole: 'ALLVA_SUPPORT',
    permissions,
    accessToken: 'token',
  });

const productTicket = (assigneeId: string | null): ProductSupportTicket => ({
  facts: {
    id: 'ticket-1',
    status: 'OPEN',
    priority: 'HIGH',
    category: null,
    assigneeId,
    createdAt: new Date(),
    lastMessageAt: new Date(),
    resolvedAt: null,
    messages: null,
  },
  payload: { id: 'ticket-1', assigneeId },
});

function build(currentAssignee: string | null) {
  const gateway = {
    get: jest.fn().mockResolvedValue(productTicket(currentAssignee)),
    assign: jest
      .fn()
      .mockImplementation((_op, _id, to: string | null) =>
        Promise.resolve(productTicket(to)),
      ),
    list: jest.fn(),
  };
  const events = { save: jest.fn(), count: jest.fn() };
  const tracker = {
    track: jest.fn().mockResolvedValue([{ sla: {}, escalation: {} }]),
  };
  const audit = { record: jest.fn() };

  const useCase = new AssignSupportTicketUseCase(
    gateway as unknown as SupportTicketsGatewayInterface,
    events as unknown as TicketAssignmentEventsRepositoryInterface,
    tracker as unknown as TicketSlaTrackerService,
    audit as unknown as BackofficeAuditLogService,
  );

  return { useCase, gateway, events, audit };
}

describe('AssignSupportTicketUseCase', () => {
  it('exige support:manage', async () => {
    const { useCase, gateway } = build(null);

    await expect(
      useCase.execute(operator(['support:read']), 'ticket-1', {
        toOperatorId: 'op-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it('assumir chamado livre não pede motivo', async () => {
    const { useCase, gateway, events } = build(null);

    await useCase.execute(operator(), 'ticket-1', { toOperatorId: 'op-1' });

    expect(gateway.assign).toHaveBeenCalledWith(
      expect.anything(),
      'ticket-1',
      'op-1',
    );
    expect(events.save).toHaveBeenCalledTimes(1);
  });

  it('repassar chamado com dono exige motivo, e não toca o produto', async () => {
    const { useCase, gateway } = build('op-2');

    await expect(
      useCase.execute(operator(), 'ticket-1', {
        toOperatorId: 'op-1',
        reason: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.assign).not.toHaveBeenCalled();
  });

  it('repasse com motivo grava o histórico e a auditoria', async () => {
    const { useCase, events, audit } = build('op-2');

    await useCase.execute(operator(), 'ticket-1', {
      toOperatorId: 'op-1',
      reason: 'Férias',
    });

    const [event] = events.save.mock.calls[0];
    expect(event.fromOperatorId).toBe('op-2');
    expect(event.toOperatorId).toBe('op-1');
    expect(event.reason).toBe('Férias');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'support.ticket.assigned' }),
    );
  });
});
