import {
  ctaButton,
  fallbackLink,
  featureGrid,
  greeting,
  noteRow,
  paragraph,
  renderEmail,
} from './design-system';
import { escapeHtml } from './html-escape';

export type WelcomeTemplateProps = {
  name: string;
  appUrl: string;
};

export const welcomeTemplate = (props: WelcomeTemplateProps) => {
  const appUrl = escapeHtml(props.appUrl);

  return renderEmail({
    title: 'Bem-vindo à Allva',
    preheader:
      'Sua conta está ativa — conecte suas contas de anúncios para começar.',
    badge: { label: '🎉&nbsp;&nbsp;Seja bem-vindo!' },
    heading: 'Bem-vindo à Allva',
    content: [
      greeting(escapeHtml(props.name)),
      paragraph(
        'Sua conta está ativa. Conecte suas contas de anúncios para começar a receber análises de desperdício, alertas e recomendações criativas.',
      ),
      featureGrid([
        {
          icon: '📈',
          title: 'Análises inteligentes',
          description:
            'Identifique oportunidades e reduza desperdícios em suas campanhas.',
        },
        {
          icon: '🔔',
          title: 'Alertas em tempo real',
          description:
            'Receba notificações sobre anormalidades e pontos de atenção.',
        },
        {
          icon: '✨',
          title: 'Recomendações criativas',
          description:
            'Aprimore seus anúncios com sugestões baseadas em dados.',
        },
      ]),
      ctaButton('Acessar a plataforma', appUrl),
      fallbackLink(appUrl),
      noteRow(
        '⚙',
        'Você pode ajustar quais e-mails recebe a qualquer momento nas preferências da sua conta.',
      ),
    ].join(''),
  });
};

export const welcomeTemplateText = (
  props: WelcomeTemplateProps,
) => `Bem-vindo à Allva

Olá ${props.name},

Sua conta está ativa. Conecte suas contas de anúncios para começar a receber análises de desperdício, alertas e recomendações criativas.

Acessar a plataforma: ${props.appUrl}

Você pode ajustar quais e-mails recebe a qualquer momento nas preferências da sua conta.

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
