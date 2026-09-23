import {
  callout,
  ctaButton,
  fallbackLink,
  paragraph,
  renderEmail,
  type EmailTone,
} from './design-system';
import { escapeHtml } from './html-escape';

export type AlertTemplateProps = {
  name: string;
  /** WARNING | CRITICAL — INFO alerts are in-app only and never reach this template. */
  severity: 'WARNING' | 'CRITICAL';
  severityLabel: string;
  title: string;
  message: string;
  /** Human-readable alert type, e.g. "Desperdicio detectado". */
  typeLabel: string;
  dateLabel: string;
  appUrl: string;
};

/** Crítico lê vermelho, atenção lê âmbar — os mesmos tons do resumo diário. */
const TONE_BY_SEVERITY: Record<AlertTemplateProps['severity'], EmailTone> = {
  CRITICAL: 'destructive',
  WARNING: 'warning',
};

const ICON_BY_SEVERITY: Record<AlertTemplateProps['severity'], string> = {
  CRITICAL: '🚨',
  WARNING: '⚠️',
};

function alertsUrl(appUrl: string): string {
  return `${appUrl}/alerts`;
}

export const alertTemplate = (props: AlertTemplateProps) => {
  const tone = TONE_BY_SEVERITY[props.severity];
  const url = escapeHtml(alertsUrl(props.appUrl));

  return renderEmail({
    title: escapeHtml(props.title),
    preheader: `${escapeHtml(props.severityLabel)} · ${escapeHtml(props.title)}`,
    badge: {
      label: `${ICON_BY_SEVERITY[props.severity]}&nbsp;&nbsp;${escapeHtml(props.severityLabel)}`,
      tone,
    },
    heading: escapeHtml(props.title),
    content: [
      paragraph(
        `${escapeHtml(props.typeLabel)} &middot; ${escapeHtml(props.dateLabel)}`,
        { variant: 'small', marginBottom: 20 },
      ),
      callout(escapeHtml(props.message), tone),
      ctaButton('Ver no painel', url),
      fallbackLink(url),
      paragraph(
        `Olá ${escapeHtml(props.name)}, este alerta foi gerado automaticamente pela análise das suas campanhas.`,
        { variant: 'small', marginTop: 22, marginBottom: 0 },
      ),
    ].join(''),
    footerNote:
      'Para deixar de receber alertas por e-mail, ajuste suas preferências de notificação no painel.',
  });
};

export const alertTemplateText = (props: AlertTemplateProps) => {
  const url = alertsUrl(props.appUrl);

  return `[${props.severityLabel}] ${props.title}

${props.typeLabel} · ${props.dateLabel}

${props.message}

Ver no painel: ${url}

Olá ${props.name}, este alerta foi gerado automaticamente pela análise das suas campanhas.

Para deixar de receber alertas por e-mail, ajuste suas preferências de notificação no painel.`;
};
