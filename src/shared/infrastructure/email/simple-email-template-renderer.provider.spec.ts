import { SimpleEmailTemplateRendererProvider } from './simple-email-template-renderer.provider';

const PROPS_BY_TEMPLATE: Record<string, unknown> = {
  'forgot-password': { name: 'Ana', resetUrl: 'https://app.test/reset' },
  'password-changed': { name: 'Ana' },
  'organization-invitation': {
    name: 'ana@empresa.com',
    inviter: 'Beto',
    url: 'https://app.test/invite',
    orgName: 'Empresa X',
  },
  'email-verification': { name: 'Ana', code: '123456', expiresInMinutes: 15 },
  welcome: { name: 'Ana', appUrl: 'https://app.test' },
  alert: {
    name: 'Ana',
    severity: 'CRITICAL',
    severityLabel: 'Crítico',
    title: 'Título',
    message: 'Mensagem',
    typeLabel: 'Tipo',
    dateLabel: '27/08/2026',
    appUrl: 'https://app.test',
  },
  'daily-summary': {
    name: 'Ana',
    date: '27/08/2026',
    wasteCount: 0,
    wasteAmountFormatted: '',
    criticalCount: 0,
    newRecommendations: 0,
    topWasteItems: [],
    appUrl: 'https://app.test',
  },
  'report-ready': {
    templateName: 'Performance semanal',
    link: 'https://app.test/r',
  },
};

describe('SimpleEmailTemplateRendererProvider', () => {
  const provider = new SimpleEmailTemplateRendererProvider();

  it.each(Object.keys(PROPS_BY_TEMPLATE))(
    'renders "%s" with a non-empty subject, html and text',
    async (templateName) => {
      const result = await provider.render(
        templateName,
        PROPS_BY_TEMPLATE[templateName],
      );

      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.html.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
    },
  );

  it('rejects an unknown template name', () => {
    expect(() => provider.render('does-not-exist', {})).toThrow();
  });
});
