import {
  codeBlock,
  greeting,
  noteRow,
  paragraph,
  renderEmail,
} from './design-system';
import { escapeHtml } from './html-escape';

export type EmailVerificationTemplateProps = {
  name: string;
  /** Os seis dígitos. Nunca o hash — este é o único lugar onde eles existem. */
  code: string;
  expiresInMinutes: number;
};

/**
 * O código é o conteúdo do email, e por isso ocupa o meio da tela.
 *
 * Não há link: o botão de confirmação abria uma aba nova, longe do cadastro que
 * a pessoa tinha acabado de preencher — e era exatamente isso que quebrava o
 * caminho até o pagamento. Quem lê este email volta para a aba que já está
 * aberta e digita seis dígitos.
 */
export const emailVerificationTemplate = (
  props: EmailVerificationTemplateProps,
) =>
  renderEmail({
    title: 'Seu código de confirmação',
    preheader: `Seu código de confirmação: ${escapeHtml(props.code)}`,
    badge: { label: '✉️&nbsp;&nbsp;Confirmação de e-mail' },
    heading: 'Seu código de confirmação',
    content: [
      greeting(escapeHtml(props.name)),
      paragraph(
        'Digite o código abaixo na tela de confirmação para ativar sua conta.',
      ),
      codeBlock(escapeHtml(props.code)),
      noteRow(
        '⏱',
        `O código expira em ${escapeHtml(props.expiresInMinutes)} minutos e só pode ser usado uma vez. Se você não criou esta conta, pode ignorar este e-mail — e não compartilhe o código com ninguém.`,
      ),
    ].join(''),
  });

export const emailVerificationTemplateText = (
  props: EmailVerificationTemplateProps,
) => `Seu código de confirmação

Olá ${props.name},

Digite o código abaixo na tela de confirmação para ativar sua conta.

${props.code}

O código expira em ${props.expiresInMinutes} minutos e só pode ser usado uma vez. Se você não criou esta conta, pode ignorar este e-mail com segurança — e não compartilhe o código com ninguém.

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
