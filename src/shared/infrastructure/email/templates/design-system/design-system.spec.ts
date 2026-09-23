import {
  alertTemplate,
  dailySummaryTemplate,
  emailVerificationTemplate,
  forgotPasswordTemplate,
  organizationInvitationTemplate,
  passwordChangedTemplate,
  reportReadyTemplate,
  supportConfirmationTemplate,
  supportRequestTemplate,
  welcomeTemplate,
} from '..';
import { COLORS, emailLogoUrl } from '.';

const APP = 'https://app.example.com';

/** Um render de cada template, com dados plausíveis — a base das invariantes. */
function renderAll(): Array<[string, string]> {
  return [
    ['welcome', welcomeTemplate({ name: 'Ana', appUrl: APP })],
    [
      'forgot-password',
      forgotPasswordTemplate({ name: 'Ana', resetUrl: `${APP}/reset?t=1` }),
    ],
    ['password-changed', passwordChangedTemplate({ name: 'Ana' })],
    [
      'email-verification',
      emailVerificationTemplate({
        name: 'Ana',
        code: '123456',
        expiresInMinutes: 15,
      }),
    ],
    [
      'organization-invitation',
      organizationInvitationTemplate({
        name: 'ana@empresa.com',
        inviter: 'Beto',
        orgName: 'Empresa X',
        url: `${APP}/invite?t=1`,
      }),
    ],
    [
      'alert',
      alertTemplate({
        name: 'Ana',
        severity: 'CRITICAL',
        severityLabel: 'Crítico',
        title: 'Desperdício detectado',
        message: 'Campanha X gastou sem conversão.',
        typeLabel: 'Desperdício',
        dateLabel: '1 de setembro de 2026',
        appUrl: APP,
      }),
    ],
    [
      'daily-summary',
      dailySummaryTemplate({
        name: 'Ana',
        date: '1 de setembro de 2026',
        wasteCount: 2,
        wasteAmountFormatted: 'R$ 1.234,50',
        criticalCount: 1,
        newRecommendations: 3,
        appUrl: APP,
        topWasteItems: [
          {
            type: 'BUDGET_CAPPED',
            diagnosis: 'Orçamento esgotado às 14h.',
            amountFormatted: 'R$ 500,00',
            priority: 'CRITICAL',
          },
        ],
      }),
    ],
    [
      'report-ready',
      reportReadyTemplate({
        templateName: 'Performance semanal',
        link: `${APP}/r/1`,
      }),
    ],
    [
      'support-request',
      supportRequestTemplate({
        ticketCode: 'SUP-1',
        priorityLabel: 'Alta',
        userName: 'Ana',
        userEmail: 'ana@empresa.com',
        organizationName: 'Empresa X',
        planLabel: 'Profissional',
        subject: 'Assunto',
        message: 'Mensagem',
        dateLabel: '1 de setembro de 2026',
      }),
    ],
    [
      'support-confirmation',
      supportConfirmationTemplate({
        userName: 'Ana',
        ticketCode: 'SUP-1',
        subject: 'Assunto',
        message: 'Mensagem',
        dateLabel: '1 de setembro de 2026',
      }),
    ],
  ];
}

describe('design system de e-mail — a logo', () => {
  const original = process.env.EMAIL_LOGO_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_LOGO_URL;
    else process.env.EMAIL_LOGO_URL = original;
  });

  it('usa EMAIL_LOGO_URL quando configurada', () => {
    process.env.EMAIL_LOGO_URL = 'https://cdn.exemplo.com/logo.png';

    expect(emailLogoUrl()).toBe('https://cdn.exemplo.com/logo.png');
    expect(welcomeTemplate({ name: 'Ana', appUrl: APP })).toContain(
      'https://cdn.exemplo.com/logo.png',
    );
  });

  /**
   * Ler a variável no envio, e não no import, é o que permite trocá-la em
   * runtime — um `const` no topo do módulo congelaria o valor do primeiro
   * `require` e este teste passaria por acidente na ordem certa de arquivos.
   */
  it('cai no site institucional quando a variável está ausente ou vazia', () => {
    delete process.env.EMAIL_LOGO_URL;
    expect(emailLogoUrl()).toBe('https://allva.com.br/assets/logos/large.png');

    process.env.EMAIL_LOGO_URL = '   ';
    expect(emailLogoUrl()).toBe('https://allva.com.br/assets/logos/large.png');
  });
});

describe('design system de e-mail — invariantes de todo template', () => {
  it.each(renderAll())(
    '%s: cabeçalho, logo e rodapé da marca',
    (_name, html) => {
      expect(html).toContain(emailLogoUrl());
      expect(html).toContain(COLORS.black);
      expect(html).toContain('Allva. Todos os direitos reservados.');
      // A classe do media query: sem ela o corpo fica com 40px de respiro lateral
      // fixo, que no celular come metade da largura útil.
      expect(html).toContain('allva-pad');
    },
  );

  /**
   * O frontend define a paleta em `oklch`; nenhum cliente de e-mail entende essa
   * função e descarta a declaração inteira, deixando o elemento com a cor
   * herdada. Se alguma cor voltar em oklch, é aqui que o erro aparece.
   */
  it.each(renderAll())('%s: nenhuma cor em oklch', (_name, html) => {
    expect(html).not.toContain('oklch(');
  });

  /** Link morto pontua em filtro de spam e leva o leitor a lugar nenhum. */
  it.each(renderAll())('%s: nenhum link vazio', (_name, html) => {
    expect(html).not.toContain('href="#"');
    expect(html).not.toMatch(/href="\s*"/);
  });
});
