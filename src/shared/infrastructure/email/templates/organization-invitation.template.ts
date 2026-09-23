import {
  ctaButton,
  fallbackLink,
  greeting,
  noteRow,
  paragraph,
  renderEmail,
  strongText,
} from './design-system';
import { escapeHtml } from './html-escape';

export type OrganizationInvitationTemplateProps = {
  name: string;
  inviter: string;
  url: string;
  orgName: string;
};

export const organizationInvitationTemplate = (
  props: OrganizationInvitationTemplateProps,
) => {
  const url = escapeHtml(props.url);

  return renderEmail({
    title: 'Convite para organização',
    preheader: `${escapeHtml(props.inviter)} convidou você para participar da organização ${escapeHtml(props.orgName)} na Allva.`,
    badge: { label: '👥&nbsp;&nbsp;Convite recebido' },
    heading: 'Convite para organização',
    content: [
      greeting(escapeHtml(props.name)),
      paragraph(
        `${strongText(escapeHtml(props.inviter))} convidou você para participar da organização ${strongText(escapeHtml(props.orgName))} na Allva.`,
      ),
      ctaButton('Aceitar convite', url),
      fallbackLink(url),
      noteRow(
        '✉',
        'Se você não esperava este convite, pode ignorar este e-mail.',
      ),
    ].join(''),
  });
};

export const organizationInvitationTemplateText = (
  props: OrganizationInvitationTemplateProps,
) => `Convite para organização

Olá ${props.name},

${props.inviter} convidou você para participar da organização ${props.orgName} na Allva.

Aceitar convite: ${props.url}

Se você não esperava este convite, pode ignorar este e-mail.

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
