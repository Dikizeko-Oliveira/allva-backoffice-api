import {
  callout,
  ctaButton,
  infoCard,
  paragraph,
  renderEmail,
} from './design-system';
import { escapeHtml } from './html-escape';

export type SupportRequestTemplateProps = {
  ticketCode: string;
  priorityLabel: string;
  userName: string;
  userEmail: string;
  organizationName: string;
  planLabel: string;
  subject: string;
  message: string;
  dateLabel: string;
  /** Já vem assinada (`SupportTicketNotifierService`) — `undefined` sem anexo. */
  attachmentUrl?: string;
};

/**
 * Vai para `ALLVA_SUPPORT_EMAIL`, nunca para o usuário — é o time de suporte
 * lendo a própria caixa de entrada. O `Reply-To` (montado por
 * `SendSupportMessageUseCase`, não aqui) é o que fecha o ciclo: responder este
 * e-mail chega ao usuário sem o suporte precisar copiar o endereço da mensagem.
 *
 * O rótulo do cabeçalho é próprio para que a mensagem se distinga na caixa do
 * suporte, que recebe também os e-mails normais da plataforma.
 */
export const supportRequestTemplate = (props: SupportRequestTemplateProps) =>
  renderEmail({
    title: escapeHtml(props.subject),
    preheader: `Nova mensagem de suporte de ${escapeHtml(props.userName)} — ${escapeHtml(props.organizationName)}`,
    headerLabel: 'Suporte',
    badge: {
      label: `🎫&nbsp;&nbsp;Prioridade ${escapeHtml(props.priorityLabel)}`,
      tone: 'warning',
    },
    heading: escapeHtml(props.subject),
    content: [
      paragraph(
        `Chamado ${escapeHtml(props.ticketCode)} &middot; ${escapeHtml(props.dateLabel)}`,
        { variant: 'small', marginBottom: 20 },
      ),
      infoCard([
        {
          label: 'Usuário',
          value: `${escapeHtml(props.userName)} &lt;${escapeHtml(props.userEmail)}&gt;`,
        },
        { label: 'Organização', value: escapeHtml(props.organizationName) },
        { label: 'Plano', value: escapeHtml(props.planLabel) },
      ]),
      callout(escapeHtml(props.message), 'warning', {
        label: 'Mensagem:',
        preserveLineBreaks: true,
      }),
      props.attachmentUrl
        ? ctaButton('Ver print anexado', escapeHtml(props.attachmentUrl)) +
          paragraph('Link válido por alguns dias.', {
            variant: 'small',
            marginBottom: 0,
            align: 'center',
          })
        : '',
    ].join(''),
    footerNote: `Responda este e-mail diretamente — a resposta vai para ${escapeHtml(props.userEmail)}.`,
  });

export const supportRequestTemplateText = (
  props: SupportRequestTemplateProps,
) => `[Suporte Allva] ${props.subject}

Chamado ${props.ticketCode} · Prioridade ${props.priorityLabel} · ${props.dateLabel}

Usuário: ${props.userName} <${props.userEmail}>
Organização: ${props.organizationName}
Plano: ${props.planLabel}

Mensagem:
${props.message}
${props.attachmentUrl ? `\nPrint anexado: ${props.attachmentUrl}\n` : ''}
Responda este e-mail diretamente — a resposta vai para ${props.userEmail}.`;
