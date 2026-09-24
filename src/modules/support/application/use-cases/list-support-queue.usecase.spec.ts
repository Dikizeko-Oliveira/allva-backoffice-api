import { ForbiddenException } from '@nestjs/common';
import { Operator } from 'src/modules/auth/domain/entities';
import type { ObservedTicket } from 'src/modules/support/domain/entities';
import type {
  ProductSupportTicket,
  SupportTicketsGatewayInterface,
} from 'src/modules/support/domain/ports';
import { PAGE_MAX_SIZE } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import type { SupportTicketOutputDto } from '../dtos';
import type { TicketSlaTrackerService } from '../services/ticket-sla-tracker.service';
import { ListSupportQueueUseCase } from './list-support-queue.usecase';

const operator = (permissions = ['support:read']) =>
  Operator.restore({
    id: 'op-1',
    name: 'Ana',
    email: 'ana@allva.com',
    platformRole: 'ALLVA_SUPPORT',
    permissions,
    accessToken: 'token',
  });

function facts(overrides: Partial<ObservedTicket> = {}): ObservedTicket {
  return {
    id: 'ticket',
    status: 'OPEN',
    priority: 'HIGH',
    category: null,
    assigneeId: null,
    createdAt: new Date(),
    lastMessageAt: new Date(),
    resolvedAt: null,
    messages: null,
    ...overrides,
  };
}

function productTicket(id: string): ProductSupportTicket {
  return { facts: facts({ id }), payload: { id } };
}

/** O que `TicketSlaTrackerService.track` devolveria — `state`/`nextDueAt` são o que os testes controlam. */
function tracked(
  id: string,
  state: SupportTicketOutputDto['sla']['state'],
  nextDueAt: Date | null = null,
): SupportTicketOutputDto {
  return {
    id,
    sla: {
      state,
      dueFirstResponseAt: null,
      dueResolutionAt: null,
      nextDueAt,
      firstOperatorReplyAt: null,
    },
    escalation: { escalatedAt: null, escalatedTo: null },
  };
}

describe('ListSupportQueueUseCase', () => {
  it('exige support:read', async () => {
    const gateway = { list: jest.fn() };
    const useCase = new ListSupportQueueUseCase(
      gateway as unknown as SupportTicketsGatewayInterface,
      { track: jest.fn() } as unknown as TicketSlaTrackerService,
    );

    await expect(
      useCase.execute(operator([]), { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.list).not.toHaveBeenCalled();
  });

  describe('sem `sla`', () => {
    it('pede uma única página ao gateway e ordena por risco dentro dela', async () => {
      const gateway = {
        list: jest.fn().mockResolvedValue({
          items: [productTicket('a'), productTicket('b'), productTicket('c')],
          total: 3,
          page: 1,
          pageSize: 20,
        }),
      };
      const track = jest
        .fn()
        .mockResolvedValue([
          tracked('a', 'ON_TRACK'),
          tracked('b', 'BREACHED'),
          tracked('c', 'AT_RISK'),
        ]);

      const useCase = new ListSupportQueueUseCase(
        gateway as unknown as SupportTicketsGatewayInterface,
        { track } as unknown as TicketSlaTrackerService,
      );

      const result = await useCase.execute(operator(), {
        status: 'OPEN',
        page: 1,
        pageSize: 20,
      });

      expect(gateway.list).toHaveBeenCalledTimes(1);
      expect(gateway.list).toHaveBeenCalledWith(expect.anything(), {
        search: undefined,
        status: 'OPEN',
        priority: undefined,
        category: undefined,
        organizationId: undefined,
        assignee: undefined,
        page: 1,
        pageSize: 20,
      });
      expect(result.items.map((item) => item.id)).toEqual(['b', 'c', 'a']);
      expect(result.total).toBe(3);
    });
  });

  describe('com `sla`', () => {
    it('varre até a página incompleta, filtra pelo estado e pagina o resultado', async () => {
      const page1 = Array.from({ length: PAGE_MAX_SIZE }, (_, i) =>
        productTicket(`p1-${i}`),
      );
      const page2 = [productTicket('p2-0'), productTicket('p2-1')];
      const gateway = {
        list: jest
          .fn()
          .mockResolvedValueOnce({
            items: page1,
            total: PAGE_MAX_SIZE + 2,
            page: 1,
            pageSize: PAGE_MAX_SIZE,
          })
          .mockResolvedValueOnce({
            items: page2,
            total: PAGE_MAX_SIZE + 2,
            page: 2,
            pageSize: PAGE_MAX_SIZE,
          }),
      };
      // Só os dois da segunda leva estão estourados; o resto está no prazo.
      const track = jest
        .fn()
        .mockImplementation((tickets: ProductSupportTicket[]) =>
          Promise.resolve(
            tickets.map((ticket) =>
              ticket.facts.id.startsWith('p2')
                ? tracked(ticket.facts.id, 'BREACHED')
                : tracked(ticket.facts.id, 'ON_TRACK'),
            ),
          ),
        );

      const useCase = new ListSupportQueueUseCase(
        gateway as unknown as SupportTicketsGatewayInterface,
        { track } as unknown as TicketSlaTrackerService,
      );

      const result = await useCase.execute(operator(), {
        sla: 'BREACHED',
        page: 1,
        pageSize: 20,
      });

      // Página incompleta (2 < PAGE_MAX_SIZE) encerra a varredura — não há terceira chamada.
      expect(gateway.list).toHaveBeenCalledTimes(2);
      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.id)).toEqual(['p2-0', 'p2-1']);
    });

    it('para de varrer no teto de segurança, mesmo com mais páginas disponíveis', async () => {
      const gateway = {
        list: jest.fn().mockImplementation(({ page }: { page: number }) =>
          Promise.resolve({
            items: Array.from({ length: PAGE_MAX_SIZE }, (_, i) =>
              productTicket(`page${page}-${i}`),
            ),
            total: 10_000,
            page,
            pageSize: PAGE_MAX_SIZE,
          }),
        ),
      };
      const track = jest
        .fn()
        .mockImplementation((tickets: ProductSupportTicket[]) =>
          Promise.resolve(
            tickets.map((ticket) => tracked(ticket.facts.id, 'ON_TRACK')),
          ),
        );

      const useCase = new ListSupportQueueUseCase(
        gateway as unknown as SupportTicketsGatewayInterface,
        { track } as unknown as TicketSlaTrackerService,
      );

      await useCase.execute(operator(), {
        sla: 'ON_TRACK',
        page: 1,
        pageSize: 20,
      });

      // Teto = 5 × PAGE_MAX_SIZE — a sexta chamada nunca acontece.
      expect(gateway.list).toHaveBeenCalledTimes(5);
    });

    it('ordena pelo prazo pendente mais próximo, com nulo por último', async () => {
      const gateway = {
        list: jest.fn().mockResolvedValueOnce({
          items: [
            productTicket('late'),
            productTicket('none'),
            productTicket('soon'),
          ],
          total: 3,
          page: 1,
          pageSize: PAGE_MAX_SIZE,
        }),
      };
      const track = jest
        .fn()
        .mockResolvedValue([
          tracked('late', 'AT_RISK', new Date('2026-01-01T12:00:00.000Z')),
          tracked('none', 'AT_RISK', null),
          tracked('soon', 'AT_RISK', new Date('2026-01-01T10:00:00.000Z')),
        ]);

      const useCase = new ListSupportQueueUseCase(
        gateway as unknown as SupportTicketsGatewayInterface,
        { track } as unknown as TicketSlaTrackerService,
      );

      const result = await useCase.execute(operator(), {
        sla: 'AT_RISK',
        page: 1,
        pageSize: 20,
      });

      expect(result.items.map((item) => item.id)).toEqual([
        'soon',
        'late',
        'none',
      ]);
    });
  });
});
