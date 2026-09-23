import {
  ctaButton,
  fallbackLink,
  paragraph,
  renderEmail,
  strongText,
} from './design-system';
import { escapeHtml } from './html-escape';

export type ReportReadyTemplateProps = {
  /** O nome do catálogo (§ REPORT_TEMPLATES), nunca o `templateKey` cru. */
  templateName: string;
  link: string;
};

export const reportReadyTemplate = (props: ReportReadyTemplateProps) => {
  const link = escapeHtml(props.link);

  return renderEmail({
    title: 'Seu relatório está pronto',
    preheader: `Seu relatório "${escapeHtml(props.templateName)}" está pronto para download.`,
    badge: { label: '📊&nbsp;&nbsp;Relatório pronto' },
    heading: 'Seu relatório está pronto',
    content: [
      paragraph(
        `O relatório ${strongText(escapeHtml(props.templateName))} foi gerado e já está disponível para download.`,
        { variant: 'lead' },
      ),
      ctaButton('Baixar PDF', link),
      fallbackLink(link),
    ].join(''),
  });
};

export const reportReadyTemplateText = (
  props: ReportReadyTemplateProps,
) => `Seu relatório está pronto

O relatório ${props.templateName} foi gerado e já está disponível para download.

Baixar PDF: ${props.link}

© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`;
