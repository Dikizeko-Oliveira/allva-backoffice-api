import { callout, infoCard, paragraph, renderEmail } from './design-system';
import { escapeHtml } from './html-escape';

export type SupportConfirmationTemplateProps = {
  userName: string;
  ticketCode: string;
  subject: string;
  message: string;
  dateLabel: string;
};

/**
 * Vai para o usuário, não para o suporte — é o recibo do chamado.
 *
 * Hoje é o **único** registro que o usuário tem acesso: não existe tela de
 * "minhas mensagens de suporte" ainda, então o código do chamado precisa
 * aparecer de forma que dê para copiar e citar numa resposta.
 */
export const supportConfirmationTemplate = (
  props: SupportConfirmationTemplateProps,
) =>
  renderEmail({
    title: 'Recebemos sua mensagem',
    preheader: `Recebemos sua mensagem de suporte — chamado ${escapeHtml(props.ticketCode)}`,
    badge: { label: '🎫&nbsp;&nbsp;Chamado registrado', tone: 'success' },
    heading: 'Recebemos sua mensagem',
    content: [
      paragraph(
        `Olá ${escapeHtml(props.userName)}, nossa equipe de suporte recebeu sua solicitação e vai responder pelo e-mail da sua conta.`,
        { variant: 'lead' },
      ),
      infoCard([
        { label: 'Chamado', value: escapeHtml(props.ticketCode) },
        { label: 'Assunto', value: escapeHtml(props.subject) },
        { label: 'Enviado em', value: escapeHtml(props.dateLabel) },
      ]),
      callout(escapeHtml(props.message), 'accent', {
        label: 'Sua mensagem:',
        preserveLineBreaks: true,
      }),
    ].join(''),
    footerNote:
      'Guarde o código do chamado para referência. Se quiser complementar sua mensagem, basta responder este e-mail.',
  });

export const supportConfirmationTemplateText = (
  props: SupportConfirmationTemplateProps,
) => `Recebemos sua mensagem

Olá ${props.userName}, nossa equipe de suporte recebeu sua solicitação e vai responder pelo e-mail da sua conta.

Chamado: ${props.ticketCode}
Assunto: ${props.subject}
Enviado em: ${props.dateLabel}

Sua mensagem:
${props.message}

Guarde o código do chamado para referência. Se quiser complementar sua mensagem, basta responder este e-mail.`;
