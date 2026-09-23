import { callout, greeting, paragraph, renderEmail } from './design-system';
import { escapeHtml } from './html-escape';

export type PasswordChangedTemplateProps = {
  name: string;
};

export const passwordChangedTemplate = (props: PasswordChangedTemplateProps) =>
  renderEmail({
    title: 'Senha alterada com sucesso',
    preheader: 'Sua senha na Allva foi alterada com sucesso.',
    badge: { label: '✅&nbsp;&nbsp;Senha atualizada', tone: 'success' },
    heading: 'Senha alterada com sucesso',
    content: [
      greeting(escapeHtml(props.name)),
      paragraph('Sua senha na Allva foi alterada com sucesso.'),
      callout(
        'Se você não reconhece essa ação, entre em contato com o suporte imediatamente.',
        'warning',
      ),
    ].join(''),
  });

export const passwordChangedTemplateText = (
  props: PasswordChangedTemplateProps,
) => `Senha alterada com sucesso

Olá ${props.name},

Sua senha na Allva foi alterada com sucesso.

Se você não reconhece essa ação, entre em contato com o suporte imediatamente.

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
