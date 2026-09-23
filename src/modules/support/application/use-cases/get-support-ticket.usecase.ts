import { Injectable, NotFoundException } from '@nestjs/common';
import { CUSTOMER_VISIBLE_MESSAGE_KINDS } from 'src/modules/support/domain/entities';
import {
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { SupportCenterAccessService } from '../services/support-center-access.service';
import { SupportAttachmentService } from '../services/support-attachment.service';
import { SupportTicketDetailOutputDto } from '../dtos';
import {
  attachmentUrlsOf,
  toSupportTicketDetailOutput,
} from '../support-ticket.presenter';

/** `GET /api/v1/support/tickets/:code` — o chamado aberto na tela. */
@Injectable()
export class GetSupportTicketUseCase {
  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly access: SupportCenterAccessService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  async execute(input: {
    code: string;
    organizationId: string | null;
  }): Promise<SupportTicketDetailOutputDto> {
    const organizationId = await this.access.assert(
      input.organizationId,
      'support-dedicated-channel',
    );

    const ticket = await this.ticketsRepository.findByCode(
      organizationId,
      input.code,
    );

    /**
     * Um código de outra organização cai aqui, no mesmo 404 de um código
     * inexistente — o filtro está no `where`. Distinguir os dois casos
     * transformaria a rota num oráculo de "este chamado existe em algum
     * lugar", e o código tem só 4 caracteres de sufixo aleatório.
     */
    if (!ticket) {
      throw new NotFoundException({
        code: 'SUPPORT_TICKET_NOT_FOUND',
        message: 'Chamado não encontrado.',
      });
    }

    /**
     * `CUSTOMER_VISIBLE_MESSAGE_KINDS` é o que separa esta rota da do painel.
     * A constante mora no domínio e o parâmetro é obrigatório no port — as
     * duas coisas juntas fazem "esqueci de filtrar a nota interna" virar erro
     * de compilação em vez de vazamento.
     */
    const messages = await this.messagesRepository.listByTicketId(
      ticket.id,
      CUSTOMER_VISIBLE_MESSAGE_KINDS,
    );

    const signedUrls = await this.attachments.signReadUrls(
      attachmentUrlsOf(ticket, messages),
    );

    return toSupportTicketDetailOutput(
      ticket,
      messages,
      // Encerrado não recebe resposta — ver `ReplyToSupportTicketUseCase`.
      ticket.status !== 'CLOSED',
      signedUrls,
    );
  }
}
