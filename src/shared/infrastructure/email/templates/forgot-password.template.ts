import {
  ctaButton,
  fallbackLink,
  greeting,
  noteRow,
  paragraph,
  renderEmail,
} from './design-system';
import { escapeHtml } from './html-escape';

export type ForgotPasswordTemplateProps = {
  name: string;
  resetUrl: string;
};

export const forgotPasswordTemplate = (props: ForgotPasswordTemplateProps) => {
  const resetUrl = escapeHtml(props.resetUrl);

  return renderEmail({
    title: 'Redefinição de senha',
    preheader: 'Recebemos um pedido para redefinir a senha da sua conta.',
    badge: { label: '🔐&nbsp;&nbsp;Segurança da conta' },
    heading: 'Redefinição de senha',
    content: [
      greeting(escapeHtml(props.name)),
      paragraph(
        'Recebemos um pedido para redefinir a senha da sua conta na Allva.',
      ),
      ctaButton('Redefinir minha senha', resetUrl),
      fallbackLink(resetUrl),
      noteRow(
        '🛡',
        'Se você não solicitou esta alteração, pode ignorar este e-mail com segurança — sua senha continua a mesma.',
      ),
    ].join(''),
  });
};

export const forgotPasswordTemplateText = (
  props: ForgotPasswordTemplateProps,
) => `Redefinição de senha

Olá ${props.name},

Recebemos um pedido para redefinir a senha da sua conta na Allva.

Redefinir minha senha: ${props.resetUrl}

Se você não solicitou esta alteração, pode ignorar este e-mail com segurança.

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
