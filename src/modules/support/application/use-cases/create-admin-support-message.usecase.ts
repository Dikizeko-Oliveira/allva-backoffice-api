import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AuditLogService } from 'src/modules/audit/application';
import { SupportTicketMessage } from 'src/modules/support/domain/entities';
import {
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import {
  CreateAdminSupportMessageInputDto,
  SupportTicketMessageDto,
} from '../dtos';
import { toSupportTicketMessageOutput } from '../support-ticket.presenter';

/**
 * `POST /api/v1/admin/support/tickets/:id/messages` — o operador responde,
 * ou anota.
 *
 * ## `CUSTOMER` não entra por aqui
 *
 * O DTO aceita só `OPERATOR` e `INTERNAL_NOTE`, e a restrição é do contrato,
 * não da tela: uma mensagem em nome do cliente vinda desta porta deixaria a
 * conversa sem como distinguir quem falou — e um operador poderia escrever
 * como se fosse o cliente. A porta do cliente é
 * `POST /support/tickets/:code/messages`, e lá o tipo é fixo.
 *
 * ## A nota interna não move a conversa
 *
 * `lastMessageAt` é "quando alguém falou **com o cliente**", e é por ele que
 * a fila ordena. Uma anotação do time não é um retorno ao cliente: deixá-la
 * mover o carimbo faria um chamado parecer respondido para quem olha a fila,
 * e é o chamado sem resposta que a fila existe para não perder.
 *
 * ## Responder não muda status
 *
 * De propósito. Mover para "em andamento" ao responder é política de
 * atendimento (C1), e há casos em que ela erra — a resposta que já resolve
 * marcaria o chamado como em andamento. O painel manda os dois na mesma
 * interação quando quiser; o `PATCH` está a um clique.
 */
@Injectable()
export class CreateAdminSupportMessageUseCase {
  private readonly logger = new Logger(CreateAdminSupportMessageUseCase.name);

  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    id: string,
    dto: CreateAdminSupportMessageInputDto,
    actorId: string,
  ): Promise<SupportTicketMessageDto> {
    await this.platformRole.assertPermission(actorId, 'support:manage');

    const ticket = await this.ticketsRepository.findById(id);

    if (!ticket) {
      throw new NotFoundException({
        code: 'SUPPORT_TICKET_NOT_FOUND',
        message: 'Chamado não encontrado.',
      });
    }

    /**
     * Encerrado recusa as duas — inclusive a nota interna.
     *
     * A tentação é liberar a nota, já que o cliente não a vê. Mas um chamado
     * `CLOSED` é o fim do assunto, e permitir escrita nele faria a conversa
     * continuar crescendo num registro que toda tela trata como encerrado.
     * Reabrir é uma decisão explícita, e o `PATCH` existe para isso.
     */
    if (ticket.status === 'CLOSED') {
      throw new ConflictException({
        code: 'SUPPORT_TICKET_CLOSED',
        message: 'Chamado encerrado. Reabra-o antes de escrever nele.',
      });
    }

    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const now = new Date();

    const message = SupportTicketMessage.create(
      {
        ticketId: ticket.id,
        kind: dto.kind,
        authorId: actor.id,
        authorName: actor.name,
        body: dto.body,
      },
      now,
    );

    await this.messagesRepository.append(message);

    // Só o que o cliente recebe move a fila — ver o cabeçalho.
    if (dto.kind === 'OPERATOR') {
      ticket.registerMessage(now);
      await this.ticketsRepository.updateTicket(ticket);
    }

    await this.audit.record({
      event: 'support.ticket.replied',
      entityType: 'support_ticket',
      entityId: ticket.id,
      actorId,
      organizationId: ticket.organizationId,
      // O corpo fica fora: a trilha registra que houve mensagem, não o que
      // ela dizia — a conversa já é o registro do conteúdo.
      metadata: { code: ticket.code, kind: dto.kind },
    });

    this.logger.log(
      `support.ticket_operator_message code=${ticket.code} actorId=${actorId} kind=${dto.kind}`,
    );

    return toSupportTicketMessageOutput(message);
  }
}
