import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { SupportTicketMessageKindValues } from 'src/modules/support/domain/entities';
import {
  SupportOrganizationContextPortInterface,
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { AdminSupportTicketDetailOutputDto } from '../dtos';
import {
  attachmentUrlsOf,
  toAdminSupportTicketDetailOutput,
} from '../support-ticket.presenter';
import { SupportAttachmentService } from '../services/support-attachment.service';

/**
 * `GET /api/v1/admin/support/tickets/:id` — a tela de atendimento.
 *
 * Por id, e não por código: é o que a URL do painel carrega
 * (`/support/[id]`). O código continua sendo o que o cliente cita, e é por
 * ele que a busca da fila procura.
 *
 * Traz a conversa **inteira**, `INTERNAL_NOTE` incluída — é a diferença entre
 * esta rota e `GET /support/tickets/:code`, e a razão de os dois caminhos não
 * compartilharem apresentador.
 */
@Injectable()
export class GetAdminSupportTicketUseCase {
  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly organizationContext: SupportOrganizationContextPortInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  async execute(
    id: string,
    actorId: string,
  ): Promise<AdminSupportTicketDetailOutputDto> {
    await this.platformRole.assertPermission(actorId, 'support:read');

    const ticket = await this.ticketsRepository.findById(id);

    if (!ticket) {
      throw new NotFoundException({
        code: 'SUPPORT_TICKET_NOT_FOUND',
        message: 'Chamado não encontrado.',
      });
    }

    const [messages, contexts] = await Promise.all([
      this.messagesRepository.listByTicketId(
        ticket.id,
        SupportTicketMessageKindValues,
      ),
      this.organizationContext.resolveMany([ticket.organizationId]),
    ]);

    const signedUrls = await this.attachments.signReadUrls(
      attachmentUrlsOf(ticket, messages),
    );

    return toAdminSupportTicketDetailOutput(
      ticket,
      contexts.get(ticket.organizationId) ?? { name: null, planType: null },
      messages,
      signedUrls,
    );
  }
}
