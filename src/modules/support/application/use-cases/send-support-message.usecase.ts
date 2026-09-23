import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  OrganizationPlanPortInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import { planLabel } from 'src/modules/plans/domain/plan-entitlements';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import {
  SupportTicket,
  SupportTicketMessage,
  SupportTicketPriority,
  resolveTicketPriority,
} from 'src/modules/support/domain/entities';
import {
  SupportTicketMessagesRepositoryInterface,
  SupportTicketsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { SupportTicketNotifierService } from '../services/support-ticket-notifier.service';
import { SupportAttachmentService } from '../services/support-attachment.service';
import { SendSupportMessageInputDto } from '../dtos/send-support-message.dto';

export type SendSupportMessageOutput = {
  sent: true;
  ticketCode: string;
  attachmentUploaded: boolean;
  priority: SupportTicketPriority;
  sentAt: Date;
};

/**
 * `POST /api/v1/support/messages` — o Drawer de suporte.
 *
 * Identidade e organização vêm do contexto autenticado, nunca do corpo — o
 * mesmo princípio de `create-contact.usecase.ts`. O plano é revalidado aqui,
 * não só no frontend: um Drawer escondido por falta de `support-email` é UX,
 * não segurança.
 *
 * **O chamado é o registro durável; os e-mails são responsabilidade de
 * `SupportTicketNotifierService`.** É por isso que `SupportTicket` é gravado
 * antes de qualquer envio — hoje não existe painel nem listagem, então a
 * linha na tabela é o único jeito de recuperar um chamado cujo e-mail falhou.
 */
@Injectable()
export class SendSupportMessageUseCase {
  private readonly logger = new Logger(SendSupportMessageUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationPlan: OrganizationPlanPortInterface,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly messagesRepository: SupportTicketMessagesRepositoryInterface,
    private readonly attachments: SupportAttachmentService,
    private readonly notifier: SupportTicketNotifierService,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    dto: SendSupportMessageInputDto;
    accountId: string;
    organizationId: string | null;
    attachment?: Express.Multer.File;
  }): Promise<SendSupportMessageOutput> {
    if (!input.organizationId) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_CONTEXT_REQUIRED',
        message: 'X-Organization-Id header is required for this resource',
      });
    }

    // Antes de qualquer trabalho async: um arquivo inválido não deve custar
    // uma consulta de entitlement.
    this.attachments.validate(input.attachment);

    const state = await this.planEntitlement.stateFor({
      organizationId: input.organizationId,
      feature: 'support-email',
    });

    if (!state.allowed) throw planLimitRefusal(state);

    // Declarado, não descoberto na hora de chamar o provedor: um
    // `ALLVA_SUPPORT_EMAIL` ausente é configuração incompleta, e a recusa diz
    // exatamente isso em vez de um 500 genérico do provedor de e-mail.
    const supportEmail = this.env.get('ALLVA_SUPPORT_EMAIL')?.trim();

    if (!supportEmail) {
      this.logger.error(
        'support.message_not_sent reason=ALLVA_SUPPORT_EMAIL_not_configured ' +
          `organizationId=${input.organizationId}`,
      );
      throw new ServiceUnavailableException({
        code: 'SUPPORT_EMAIL_NOT_CONFIGURED',
        message: 'O canal de suporte por e-mail não está configurado.',
      });
    }

    const [account, organization, planType, hasPriority] = await Promise.all([
      this.accountsRepository.findById(input.accountId),
      this.organizationsRepository.findById(input.organizationId),
      this.organizationPlan.findPlanTypeByOrganizationId(input.organizationId),
      this.planEntitlement.allows({
        organizationId: input.organizationId,
        feature: 'support-priority',
      }),
    ]);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const attachment = input.attachment
      ? await this.attachments.upload(input.attachment, input.organizationId)
      : null;

    const ticket = SupportTicket.create({
      accountId: input.accountId,
      organizationId: input.organizationId,
      authorName: account.name,
      authorEmail: account.email,
      subject: input.dto.subject,
      message: input.dto.message,
      category: input.dto.category,
      priority: resolveTicketPriority(input.dto.priority, hasPriority),
      attachment,
    });

    await this.ticketsRepository.save(ticket);

    /**
     * A mensagem que abriu o chamado é também a primeira da conversa.
     *
     * Duas casas para o mesmo texto, e é deliberado: `support_tickets.message`
     * é o corpo do pedido original — o que foi citado no e-mail que sai logo
     * abaixo — e não é reescrito nunca. A linha em `support_ticket_messages` é
     * a conversa, que cresce. Sem ela, toda conversa começaria pela resposta
     * do operador, como se o cliente não tivesse dito nada.
     *
     * Fora da transação do `save` porque não há transação: o chamado é o
     * registro durável, e uma falha aqui deixa um chamado completo com a
     * conversa vazia — recuperável a partir da própria coluna `message`. O
     * inverso, mensagem sem chamado, não é.
     */
    await this.messagesRepository.append(
      SupportTicketMessage.create(
        {
          ticketId: ticket.id,
          kind: 'CUSTOMER',
          authorId: ticket.accountId,
          authorName: ticket.authorName,
          body: ticket.message,
          // O print da abertura pertence à mensagem de abertura — é onde a
          // conversa o mostra.
          attachment,
        },
        ticket.createdAt,
      ),
    );

    this.logger.log(
      `support.ticket_created code=${ticket.code} organizationId=${input.organizationId} accountId=${input.accountId} priority=${ticket.priority}`,
    );

    await this.notifier.notifyBoth(ticket, {
      userName: account.name,
      userEmail: account.email,
      organizationName: organization?.name ?? '—',
      planLabel: planLabel(planType),
      supportEmail,
    });

    return {
      sent: true,
      ticketCode: ticket.code,
      attachmentUploaded: ticket.hasAttachment,
      priority: ticket.priority,
      sentAt: ticket.createdAt,
    };
  }
}
