import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AuditLogService } from 'src/modules/audit/application';
import { SupportTicketMessageKindValues } from 'src/modules/support/domain/entities';
import {
  SupportOrganizationContextPortInterface,
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import {
  AdminSupportTicketDetailOutputDto,
  UpdateAdminSupportTicketInputDto,
} from '../dtos';
import {
  attachmentUrlsOf,
  toAdminSupportTicketDetailOutput,
} from '../support-ticket.presenter';
import { SupportAttachmentService } from '../services/support-attachment.service';

/**
 * `PATCH /api/v1/admin/support/tickets/:id` — status e responsável.
 *
 * Os dois na mesma rota porque é assim que a tela funciona: pegar um chamado
 * é atribuí-lo a si **e** movê-lo para "em andamento". Dois `PATCH`
 * deixariam a fila num estado intermediário se o segundo falhasse.
 *
 * ## O que esta rota não faz
 *
 * Não reordena fila, não escalona por tempo aberto, não aplica política de
 * SLA e não guarda histórico de atribuição — só o responsável **corrente**.
 * Tudo isso é C1 no mapa de endpoints do backoffice, e a fronteira é a mesma
 * que o mapa desenha: o `allva-api` guarda o registro (quem é o responsável
 * agora, em que estado o chamado está); como a Allva se organiza para chegar
 * a esse estado é processo interno, e mora no backoffice.
 *
 * O responsável corrente fica aqui, e não lá, por uma razão concreta: o
 * cliente o vê. `GET /support/tickets/:code` devolve "Responsável" na tela
 * dele, e um dado que o produto mostra não pode morar num banco a que o
 * produto não tem acesso.
 */
@Injectable()
export class UpdateAdminSupportTicketUseCase {
  private readonly logger = new Logger(UpdateAdminSupportTicketUseCase.name);

  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly organizationContext: SupportOrganizationContextPortInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly attachments: SupportAttachmentService,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    id: string,
    dto: UpdateAdminSupportTicketInputDto,
    actorId: string,
  ): Promise<AdminSupportTicketDetailOutputDto> {
    await this.platformRole.assertPermission(actorId, 'support:manage');

    const touchesStatus = dto.status !== undefined;
    const touchesAssignee = dto.assigneeId !== undefined;

    // `{}` chegaria até o banco, escreveria `updated_at` e devolveria 200 —
    // uma escrita que não escreveu nada, indistinguível de sucesso.
    if (!touchesStatus && !touchesAssignee) {
      throw new BadRequestException({
        code: 'NOTHING_TO_UPDATE',
        message: 'Informe ao menos `status` ou `assigneeId`.',
      });
    }

    const ticket = await this.ticketsRepository.findById(id);

    if (!ticket) {
      throw new NotFoundException({
        code: 'SUPPORT_TICKET_NOT_FOUND',
        message: 'Chamado não encontrado.',
      });
    }

    const previous = { status: ticket.status, assigneeId: ticket.operatorId };
    const now = new Date();

    if (touchesAssignee) {
      /**
       * O responsável precisa poder **atender** — `support:manage`, e não só
       * "ser operador".
       *
       * Sem checagem, um id qualquer de `accounts` entraria em `operator_id`,
       * inclusive o de um cliente, cujo nome o produto mostraria como
       * "Responsável" na tela de outra organização. E "é operador" também não
       * basta desde que existem papéis por área: um chamado atribuído ao
       * comercial fica parado com alguém que não consegue respondê-lo.
       */
      if (
        dto.assigneeId !== null &&
        !(await this.platformRole.accountHasPermission(
          dto.assigneeId as string,
          'support:manage',
        ))
      ) {
        throw new BadRequestException({
          code: 'INVALID_TICKET_ASSIGNEE',
          message:
            'O responsável precisa ser um operador com permissão de atendimento.',
        });
      }

      ticket.assignTo(dto.assigneeId ?? null, now);
    }

    if (touchesStatus) ticket.changeStatus(dto.status!, now);

    await this.ticketsRepository.updateTicket(ticket);

    await this.recordAudit(ticket, previous, actorId);

    this.logger.log(
      `support.ticket_updated code=${ticket.code} actorId=${actorId} ` +
        `status=${ticket.status} assigneeId=${ticket.operatorId ?? 'none'}`,
    );

    // Relê: `assignTo` zera o nome de exibição do operador de propósito (ele
    // vem de `join`), e devolver o objeto em memória mostraria "sem
    // responsável" logo depois de atribuir.
    const fresh = (await this.ticketsRepository.findById(id)) ?? ticket;

    const [messages, contexts] = await Promise.all([
      this.messagesRepository.listByTicketId(
        fresh.id,
        SupportTicketMessageKindValues,
      ),
      this.organizationContext.resolveMany([fresh.organizationId]),
    ]);

    const signedUrls = await this.attachments.signReadUrls(
      attachmentUrlsOf(fresh, messages),
    );

    return toAdminSupportTicketDetailOutput(
      fresh,
      contexts.get(fresh.organizationId) ?? { name: null, planType: null },
      messages,
      signedUrls,
    );
  }

  /**
   * Um evento por fato, e só quando o fato mudou.
   *
   * Registrar "atribuído" numa requisição que só mexeu no status encheria a
   * trilha de linhas que não descrevem nada — e a trilha só é útil enquanto
   * toda linha significa alguma coisa.
   */
  private async recordAudit(
    ticket: {
      id: string;
      code: string;
      organizationId: string;
      status: string;
      operatorId: string | null;
    },
    previous: { status: string; assigneeId: string | null },
    actorId: string,
  ): Promise<void> {
    if (ticket.operatorId !== previous.assigneeId) {
      await this.audit.record({
        event: 'support.ticket.assigned',
        entityType: 'support_ticket',
        entityId: ticket.id,
        actorId,
        organizationId: ticket.organizationId,
        metadata: {
          code: ticket.code,
          from: previous.assigneeId,
          to: ticket.operatorId,
        },
      });
    }

    if (ticket.status !== previous.status) {
      await this.audit.record({
        event: 'support.ticket.status_changed',
        entityType: 'support_ticket',
        entityId: ticket.id,
        actorId,
        organizationId: ticket.organizationId,
        metadata: {
          code: ticket.code,
          from: previous.status,
          to: ticket.status,
        },
      });
    }
  }
}
