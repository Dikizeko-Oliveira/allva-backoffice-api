import {
  callout,
  ctaButton,
  fallbackLink,
  listRows,
  paragraph,
  renderEmail,
  sectionTitle,
  statGrid,
  strongText,
  type EmailTone,
} from './design-system';
import { escapeHtml } from './html-escape';

export type DailySummaryTemplateProps = {
  name: string;
  date: string;
  wasteCount: number;
  wasteAmountFormatted: string;
  criticalCount: number;
  newRecommendations: number;
  topWasteItems: Array<{
    type: string;
    diagnosis: string;
    amountFormatted: string;
    priority: string;
  }>;
  appUrl: string;
};

const priorityTone = (priority: string): EmailTone =>
  priority === 'CRITICAL' ? 'destructive' : 'warning';

export const dailySummaryTemplate = (props: DailySummaryTemplateProps) => {
  const appUrl = escapeHtml(props.appUrl);

  const wasteAmount = props.wasteAmountFormatted
    ? callout(
        `Desperdício potencial identificado: ${strongText(escapeHtml(props.wasteAmountFormatted))}`,
        'warning',
      )
    : '';

  const wasteList = props.topWasteItems.length
    ? sectionTitle('Principais desperdícios') +
      listRows(
        props.topWasteItems.map((item) => ({
          title: escapeHtml(item.type.replace(/_/g, ' ')),
          tag: {
            label: escapeHtml(item.priority),
            tone: priorityTone(item.priority),
          },
          description: escapeHtml(item.diagnosis),
          meta: `Impacto estimado: ${strongText(escapeHtml(item.amountFormatted))}`,
        })),
      )
    : '';

  return renderEmail({
    title: `Resumo do dia — ${escapeHtml(props.date)}`,
    preheader: `${escapeHtml(props.criticalCount)} alertas críticos · ${escapeHtml(props.wasteCount)} itens de desperdício · ${escapeHtml(props.newRecommendations)} recomendações novas`,
    badge: { label: '📊&nbsp;&nbsp;Resumo diário' },
    heading: `Resumo do dia`,
    content: [
      paragraph(
        `Olá ${escapeHtml(props.name)}, aqui está o que aconteceu nas suas campanhas em ${escapeHtml(props.date)}.`,
        { variant: 'lead' },
      ),
      statGrid([
        {
          value: escapeHtml(props.criticalCount),
          label: 'Alertas críticos',
          tone: 'destructive',
        },
        {
          value: escapeHtml(props.wasteCount),
          label: 'Itens de desperdício',
          tone: 'warning',
        },
        {
          value: escapeHtml(props.newRecommendations),
          label: 'Recomendações novas',
          tone: 'success',
        },
      ]),
      wasteAmount,
      wasteList,
      ctaButton('Ver recomendações completas', appUrl),
      fallbackLink(appUrl),
    ].join(''),
    footerNote:
      'Para parar de receber este resumo, ajuste suas preferências de notificação na plataforma.',
  });
};

export const dailySummaryTemplateText = (props: DailySummaryTemplateProps) => {
  const lines = [
    `Resumo do dia — ${props.date}`,
    '',
    `Olá ${props.name}, aqui está o que aconteceu nas suas campanhas hoje.`,
    '',
    `Alertas críticos: ${props.criticalCount}`,
    `Itens de desperdício: ${props.wasteCount}`,
    `Recomendações novas: ${props.newRecommendations}`,
  ];

  if (props.wasteAmountFormatted) {
    lines.push(
      '',
      `Desperdício potencial identificado: ${props.wasteAmountFormatted}`,
    );
  }

  if (props.topWasteItems.length > 0) {
    lines.push('', 'Principais desperdícios:');
    for (const item of props.topWasteItems) {
      lines.push(
        `- [${item.priority}] ${item.type.replace(/_/g, ' ')}: ${item.diagnosis} (impacto estimado: ${item.amountFormatted})`,
      );
    }
  }

  lines.push(
    '',
    `Ver recomendações completas: ${props.appUrl}`,
    '',
    'Para parar de receber este resumo, ajuste suas preferências de notificação na plataforma.',
    '',
    `© ${new Date().getFullYear()} Allva. Todos os direitos reservados.`,
  );

  return lines.join('\n');
};
