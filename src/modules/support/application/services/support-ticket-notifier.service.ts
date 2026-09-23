import { Injectable, Logger } from '@nestjs/common';
import { SupportTicket } from 'src/modules/support/domain/entities';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
  StoragePortInterface,
} from 'src/shared/application/ports';

const PRIORITY_LABEL: Record<SupportTicket['priority'], string> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
  CRITICAL: 'Crítica',
};

/**
 * 3 dias: cabe dentro do teto de 7 dias do V4 signing do GCS mesmo somando a
 * janela de `signedUrlWindow` (até 2x o TTL), e é folga suficiente para quem
 * triagem chamados não abre no mesmo minuto em que chegam. Não existe rota
 * autenticada para reassinar sob demanda ainda — o link vai direto no e-mail.
 */
const ATTACHMENT_LINK_TTL_SECONDS = 3 * 24 * 60 * 60;

export type SupportTicketContext = {
  userName: string;
  userEmail: string;
  organizationName: string;
  planLabel: string;
  supportEmail: string;
  dateLabel: string;
};

/**
 * O contexto sem `dateLabel` — o que quem cria o chamado de fato conhece.
 *
 * A data formatada é derivada do próprio chamado, e pedi-la ao chamador era
 * obrigá-lo a saber o formato e o fuso dos dois e-mails. `notifyBoth` a
 * calcula.
 */
export type SupportTicketNotificationInput = Omit<
  SupportTicketContext,
  'dateLabel'
>;

/**
 * Os dois e-mails de um chamado, separados de `SendSupportMessageUseCase` pelo
 * mesmo motivo que `AlertNotifierService` vive fora de quem cria o alerta: a
 * lógica de "qual template, qual destinatário, qual Reply-To" não é a lógica
 * de "este chamado pode existir".
 *
 * **Assimetria deliberada entre os dois métodos.** `notifySupportTeam` propaga
 * a exceção — é o único aviso em tempo real que a equipe tem hoje, sem painel
 * nem listagem. `notifyRequester` nunca lança: é um recibo, e falhar em
 * mandá-lo não pode derrubar um chamado que já foi salvo e já chegou ao
 * suporte.
 */
@Injectable()
export class SupportTicketNotifierService {
  private readonly logger = new Logger(SupportTicketNotifierService.name);

  constructor(
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly storage: StoragePortInterface,
  ) {}

  /**
   * Os dois e-mails do chamado recém-criado, na ordem que importa.
   *
   * Equipe primeiro: é o único aviso em tempo real que ela tem, e é o envio
   * que propaga exceção. O recibo do solicitante vai depois e nunca derruba
   * nada — a assimetria está documentada na classe.
   *
   * Existe para que o use case não precise montar `dateLabel` nem conhecer a
   * ordem: "qual e-mail, para quem, em que sequência" é justamente o que
   * este serviço responde.
   */
  async notifyBoth(
    ticket: SupportTicket,
    input: SupportTicketNotificationInput,
  ): Promise<void> {
    const context: SupportTicketContext = {
      ...input,
      dateLabel: ticket.createdAt.toLocaleString('pt-BR', {
        dateStyle: 'long',
        timeStyle: 'short',
      }),
    };

    await this.notifySupportTeam(ticket, context);
    await this.notifyRequester(ticket, context);
  }

  /** `to` é sempre `context.supportEmail` — nunca o corpo da requisição. */
  async notifySupportTeam(
    ticket: SupportTicket,
    context: SupportTicketContext,
  ): Promise<void> {
    const email = await this.emailTemplates.render('support-request', {
      ticketCode: ticket.code,
      priorityLabel: PRIORITY_LABEL[ticket.priority],
      userName: context.userName,
      userEmail: context.userEmail,
      organizationName: context.organizationName,
      planLabel: context.planLabel,
      subject: ticket.subject,
      message: ticket.message,
      dateLabel: context.dateLabel,
      attachmentUrl: await this.attachmentLinkFor(ticket),
    });

    // Reply-To é o usuário: quem responde este e-mail fala com ele
    // diretamente, sem usar o e-mail dele como remetente (SPF/DKIM/DMARC).
    await this.emailSender.send({
      to: context.supportEmail,
      subject: `[Suporte Allva] ${ticket.subject}`,
      html: email.html,
      text: email.text,
      replyTo: context.userEmail,
    });

    this.logger.log(
      `support.message_sent code=${ticket.code} organizationId=${ticket.organizationId} accountId=${ticket.accountId}`,
    );
  }

  /** Reply-To é o suporte: uma resposta à confirmação ainda chega à equipe. */
  async notifyRequester(
    ticket: SupportTicket,
    context: SupportTicketContext,
  ): Promise<void> {
    try {
      const email = await this.emailTemplates.render('support-confirmation', {
        userName: context.userName,
        ticketCode: ticket.code,
        subject: ticket.subject,
        message: ticket.message,
        dateLabel: context.dateLabel,
      });

      await this.emailSender.send({
        to: context.userEmail,
        subject: `Recebemos sua mensagem — Chamado ${ticket.code}`,
        html: email.html,
        text: email.text,
        replyTo: context.supportEmail,
      });
    } catch (error) {
      this.logger.error(
        `support.confirmation_not_sent code=${ticket.code} accountId=${ticket.accountId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `undefined` sem anexo, e também se a assinatura falhar — um link quebrado
   * no e-mail é pior que a ausência dele, e o chamado (com o anexo intacto no
   * bucket) já está salvo de qualquer forma.
   */
  private async attachmentLinkFor(
    ticket: SupportTicket,
  ): Promise<string | undefined> {
    if (!ticket.attachmentUrl) return undefined;

    try {
      return await this.storage.getReadUrl(
        ticket.attachmentUrl,
        ATTACHMENT_LINK_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.error(
        `support.attachment_link_failed code=${ticket.code}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }
}
