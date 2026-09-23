import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { SupportTicketMessage } from 'src/modules/support/domain/entities';
import {
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { SupportCenterAccessService } from '../services/support-center-access.service';
import { SupportAttachmentService } from '../services/support-attachment.service';
import {
  ReplySupportTicketInputDto,
  ReplySupportTicketOutputDto,
} from '../dtos';
import { toSupportTicketMessageOutput } from '../support-ticket.presenter';

/**
 * `POST /api/v1/support/tickets/:code/messages` — o cliente responde.
 *
 * ## Por que existe
 *
 * Sem ele, a conversa é de mão única: o operador responde, o cliente lê, e
 * para dizer qualquer coisa de volta precisa abrir **outro** chamado. O
 * histórico do problema fica partido em dois códigos, e o operador perde o
 * fio — que é exatamente o que um chamado existe para não deixar acontecer.
 *
 * ## Responder num chamado resolvido o reabre
 *
 * É a única regra de fluxo que mora aqui, e ela é do registro, não da fila:
 * um chamado marcado como resolvido que recebe uma mensagem **não está**
 * resolvido, e deixá-lo assim esconderia a mensagem de toda tela que filtra
 * por trabalho em aberto. Prioridade, responsável e ordenação de fila
 * continuam sendo decisão do painel (C1 no mapa de endpoints do backoffice).
 *
 * `CLOSED` é diferente de `RESOLVED` e por isso recusa: encerrado é o fim do
 * assunto, e reabrir por mensagem faria um chamado de meses atrás voltar à
 * fila. A recusa diz o que fazer no lugar.
 */
@Injectable()
export class ReplyToSupportTicketUseCase {
  private readonly logger = new Logger(ReplyToSupportTicketUseCase.name);

  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly access: SupportCenterAccessService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  async execute(input: {
    code: string;
    dto: ReplySupportTicketInputDto;
    accountId: string;
    organizationId: string | null;
    /** Opcional — o print que o operador pediu. Mesmas regras da abertura. */
    attachment?: Express.Multer.File;
  }): Promise<ReplySupportTicketOutputDto> {
    // Antes de qualquer consulta: arquivo inválido não custa entitlement.
    this.attachments.validate(input.attachment);

    const organizationId = await this.access.assert(
      input.organizationId,
      'support-dedicated-channel',
    );

    const ticket = await this.ticketsRepository.findByCode(
      organizationId,
      input.code,
    );

    if (!ticket) {
      throw new NotFoundException({
        code: 'SUPPORT_TICKET_NOT_FOUND',
        message: 'Chamado não encontrado.',
      });
    }

    if (ticket.status === 'CLOSED') {
      throw new ConflictException({
        code: 'SUPPORT_TICKET_CLOSED',
        message:
          'Este chamado foi encerrado. Abra um novo chamado para continuar o atendimento.',
      });
    }

    const account = await this.accountsRepository.findById(input.accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    // Sobe só depois de todas as recusas: um chamado encerrado não pode
    // deixar um arquivo órfão no bucket.
    const attachment = input.attachment
      ? await this.attachments.upload(input.attachment, organizationId)
      : null;

    const now = new Date();

    /**
     * Quem responde é quem está logado, e **não precisa ser quem abriu**.
     *
     * O chamado é da organização, não da pessoa: o analista que abriu pode
     * estar de férias quando a resposta chega, e exigir o autor original
     * deixaria o time sem como continuar a própria conversa. O nome vai
     * carimbado na mensagem, então a conversa continua dizendo quem falou.
     */
    const message = SupportTicketMessage.create(
      {
        ticketId: ticket.id,
        kind: 'CUSTOMER',
        authorId: account.id,
        authorName: account.name,
        body: input.dto.message,
        attachment,
      },
      now,
    );

    await this.messagesRepository.append(message);

    ticket.registerMessage(now);
    if (ticket.status === 'RESOLVED') ticket.changeStatus('OPEN', now);

    await this.ticketsRepository.updateTicket(ticket);

    this.logger.log(
      `support.ticket_reply code=${ticket.code} organizationId=${organizationId} ` +
        `accountId=${account.id} status=${ticket.status}`,
    );

    const signedUrls = await this.attachments.signReadUrls([
      message.attachment?.url,
    ]);

    return {
      message: toSupportTicketMessageOutput(message, signedUrls),
      status: ticket.status,
    };
  }
}
