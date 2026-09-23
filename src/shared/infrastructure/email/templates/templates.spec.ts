import {
  alertTemplate,
  alertTemplateText,
  dailySummaryTemplate,
  dailySummaryTemplateText,
  emailVerificationTemplate,
  emailVerificationTemplateText,
  forgotPasswordTemplate,
  forgotPasswordTemplateText,
  organizationInvitationTemplate,
  organizationInvitationTemplateText,
  passwordChangedTemplate,
  passwordChangedTemplateText,
  reportReadyTemplate,
  reportReadyTemplateText,
  supportRequestTemplate,
  supportRequestTemplateText,
  supportConfirmationTemplate,
  supportConfirmationTemplateText,
  welcomeTemplate,
  welcomeTemplateText,
} from '.';

const GARBAGE = /\b(NaN|undefined|null)\b/;

/**
 * Sem `<meta charset="utf-8">` (e sem `<head>` nenhum, antes desta correção),
 * um cliente de email decide sozinho como ler os bytes acentuados — foi assim
 * que a maioria dos templates passou a evitar acento em vez de arriscar
 * mojibake. Todo template precisa declarar o charset explicitamente para que
 * usar acentuação pt-BR normalmente seja seguro.
 */
function assertWellFormedHtml(html: string) {
  expect(html).toContain('<!doctype html>');
  expect(html.toLowerCase()).toContain('<meta charset="utf-8"');
  expect(html).not.toMatch(GARBAGE);
  expect(html).not.toContain('${');
}

function assertPlainText(text: string) {
  expect(text).not.toMatch(GARBAGE);
  expect(text).not.toContain('${');
  expect(text).not.toMatch(/<\/?(html|body|table|div|a|p)\b/i);
}

describe('email templates — HTML + plain text', () => {
  it('welcome: CTA aponta para o appUrl recebido, sem URL hardcoded', () => {
    const props = { name: 'Ana', appUrl: 'https://app.example.com' };
    const html = welcomeTemplate(props);
    const text = welcomeTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.appUrl);
    expect(text).toContain(props.appUrl);
  });

  it('forgot-password: CTA aponta para o resetUrl recebido', () => {
    const props = {
      name: 'Ana',
      resetUrl: 'https://app.example.com/auth/reset-password?token=abc',
    };
    const html = forgotPasswordTemplate(props);
    const text = forgotPasswordTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.resetUrl);
    expect(text).toContain(props.resetUrl);
  });

  it('password-changed: não tem link nenhum', () => {
    const props = { name: 'Ana' };
    const html = passwordChangedTemplate(props);
    const text = passwordChangedTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
  });

  it('organization-invitation: CTA aponta para a url do convite', () => {
    const props = {
      name: 'ana@empresa.com',
      inviter: 'Beto',
      url: 'https://app.example.com/invite/accept?token=xyz',
      orgName: 'Empresa X',
    };
    const html = organizationInvitationTemplate(props);
    const text = organizationInvitationTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.url);
    expect(text).toContain(props.url);
  });

  it('email-verification: sem link, por desenho — só o código', () => {
    const props = { name: 'Ana', code: '123456', expiresInMinutes: 15 };
    const html = emailVerificationTemplate(props);
    const text = emailVerificationTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.code);
    expect(text).toContain(props.code);
    expect(html).not.toContain('<a href');
  });

  it('alert: CTA aponta para {appUrl}/alerts', () => {
    const props = {
      name: 'Ana',
      severity: 'CRITICAL' as const,
      severityLabel: 'Crítico',
      title: 'Desperdício crítico detectado',
      message: 'Campanha X gastou sem conversão.',
      typeLabel: 'Desperdício detectado',
      dateLabel: '27 de agosto de 2026',
      appUrl: 'https://app.example.com',
    };
    const html = alertTemplate(props);
    const text = alertTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain('https://app.example.com/alerts');
    expect(text).toContain('https://app.example.com/alerts');
  });

  it('daily-summary: renderiza com e sem desperdício, sem link hardcoded', () => {
    const base = {
      name: 'Ana',
      date: '27 de agosto de 2026',
      wasteCount: 0,
      wasteAmountFormatted: '',
      criticalCount: 0,
      newRecommendations: 0,
      topWasteItems: [],
      appUrl: 'https://app.example.com',
    };

    assertWellFormedHtml(dailySummaryTemplate(base));
    assertPlainText(dailySummaryTemplateText(base));

    const withItems = {
      ...base,
      wasteCount: 2,
      wasteAmountFormatted: 'R$ 1.234,50',
      criticalCount: 1,
      newRecommendations: 3,
      topWasteItems: [
        {
          type: 'BUDGET_CAPPED',
          diagnosis: 'Orçamento diário esgotado às 14h.',
          amountFormatted: 'R$ 500,00',
          priority: 'CRITICAL',
        },
      ],
    };

    const html = dailySummaryTemplate(withItems);
    const text = dailySummaryTemplateText(withItems);
    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(base.appUrl);
    expect(html).toContain('R$ 1.234,50');
    expect(text).toContain('R$ 1.234,50');
  });

  it('report-ready: CTA aponta para o link de download recebido', () => {
    const props = {
      templateName: 'Performance semanal',
      link: 'https://api.example.com/api/v1/reports/r-1/file?token=abc',
    };
    const html = reportReadyTemplate(props);
    const text = reportReadyTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.link);
    expect(text).toContain(props.link);
    expect(html).toContain(props.templateName);
  });

  it('support-request: leva código, prioridade, contexto e mensagem — sem CTA', () => {
    const props = {
      ticketCode: 'SUP-20260827-7K4N',
      priorityLabel: 'Alta',
      userName: 'Ana',
      userEmail: 'ana@empresa.com',
      organizationName: 'Empresa X',
      planLabel: 'Profissional',
      subject: 'Não consigo conectar minha conta do Meta',
      message: 'O botão de conectar não responde depois do login.',
      dateLabel: '27 de agosto de 2026 às 14:32',
    };
    const html = supportRequestTemplate(props);
    const text = supportRequestTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.ticketCode);
    expect(html).toContain(props.priorityLabel);
    expect(html).toContain(props.subject);
    expect(html).toContain(props.userEmail);
    expect(html).toContain(props.organizationName);
    expect(html).toContain(props.planLabel);
    expect(html).toContain(props.message);
    expect(text).toContain(props.ticketCode);
    expect(text).toContain(props.priorityLabel);
    expect(text).toContain(props.subject);
    expect(text).toContain(props.userEmail);
    expect(text).toContain(props.organizationName);
    expect(text).toContain(props.planLabel);
    expect(text).toContain(props.message);
  });

  it('support-request: mostra o link do anexo só quando ele existe', () => {
    const base = {
      ticketCode: 'SUP-20260827-7K4N',
      priorityLabel: 'Alta',
      userName: 'Ana',
      userEmail: 'ana@empresa.com',
      organizationName: 'Empresa X',
      planLabel: 'Profissional',
      subject: 'Assunto',
      message: 'Mensagem',
      dateLabel: '27/08/2026',
    };

    const withoutAttachment = supportRequestTemplate(base);
    assertWellFormedHtml(withoutAttachment);
    expect(withoutAttachment).not.toContain('Ver print anexado');

    const attachmentUrl =
      'https://storage.googleapis.com/bucket/print.png?sig=abc';
    const withAttachment = supportRequestTemplate({ ...base, attachmentUrl });
    const text = supportRequestTemplateText({ ...base, attachmentUrl });

    assertWellFormedHtml(withAttachment);
    assertPlainText(text);
    expect(withAttachment).toContain('Ver print anexado');
    expect(withAttachment).toContain(attachmentUrl);
    expect(text).toContain(attachmentUrl);
  });

  it('support-confirmation: leva código do chamado e a mensagem do usuário — recibo, sem link', () => {
    const props = {
      userName: 'Ana',
      ticketCode: 'SUP-20260827-7K4N',
      subject: 'Não consigo conectar minha conta do Meta',
      message: 'O botão de conectar não responde depois do login.',
      dateLabel: '27 de agosto de 2026 às 14:32',
    };
    const html = supportConfirmationTemplate(props);
    const text = supportConfirmationTemplateText(props);

    assertWellFormedHtml(html);
    assertPlainText(text);
    expect(html).toContain(props.ticketCode);
    expect(html).toContain(props.subject);
    expect(html).toContain(props.message);
    expect(text).toContain(props.ticketCode);
    expect(text).toContain(props.subject);
    expect(text).toContain(props.message);
  });
});

/**
 * Nome de conta, nome de organização e mensagem de alerta são texto de
 * negócio, não HTML de confiança — chega vindo de cadastro, de convite ou de
 * um detector que descreve uma campanha. Sem escaping, um nome com `<` ou
 * `"` quebrava a marcação da mensagem (ou, na pior das hipóteses, injetava
 * uma tag); com escaping, o texto original ainda aparece — só que como texto,
 * nunca como marcação.
 */
describe('email templates — escaping de conteúdo dinâmico no HTML', () => {
  const INJECTION = `<img src=x onerror=alert(1)> & "aspas" 'simples'`;
  const ESCAPED_FRAGMENTS = ['&lt;img', '&amp;', '&quot;aspas&quot;'];

  function assertEscaped(html: string) {
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    for (const fragment of ESCAPED_FRAGMENTS) {
      expect(html).toContain(fragment);
    }
  }

  it('welcome: escapa o nome da conta', () => {
    assertEscaped(
      welcomeTemplate({ name: INJECTION, appUrl: 'https://app.test' }),
    );
  });

  it('organization-invitation: escapa nome, convidador e organização', () => {
    const html = organizationInvitationTemplate({
      name: INJECTION,
      inviter: INJECTION,
      orgName: INJECTION,
      url: 'https://app.test/invite',
    });

    assertEscaped(html);
    // As três ocorrências (saudação, corpo x2) precisam ter sido escapadas —
    // não só a primeira que o helper encontrasse.
    expect(html.match(/<img src=x/g)).toBeNull();
  });

  it('alert: escapa título e mensagem, inclusive dentro da <title>', () => {
    const html = alertTemplate({
      name: 'Ana',
      severity: 'CRITICAL',
      severityLabel: 'Crítico',
      title: INJECTION,
      message: INJECTION,
      typeLabel: 'Desperdício detectado',
      dateLabel: '27/08/2026',
      appUrl: 'https://app.test',
    });

    assertEscaped(html);
  });

  it('daily-summary: escapa o diagnóstico de um item de desperdício', () => {
    const html = dailySummaryTemplate({
      name: 'Ana',
      date: '27/08/2026',
      wasteCount: 1,
      wasteAmountFormatted: 'R$ 100,00',
      criticalCount: 1,
      newRecommendations: 0,
      appUrl: 'https://app.test',
      topWasteItems: [
        {
          type: 'BUDGET_CAPPED',
          diagnosis: INJECTION,
          amountFormatted: 'R$ 100,00',
          priority: 'CRITICAL',
        },
      ],
    });

    assertEscaped(html);
  });

  it('report-ready: escapa o nome do template', () => {
    assertEscaped(
      reportReadyTemplate({
        templateName: INJECTION,
        link: 'https://app.test/r',
      }),
    );
  });

  it('support-request: escapa nome, organização, assunto e mensagem do usuário', () => {
    const html = supportRequestTemplate({
      ticketCode: 'SUP-20260827-7K4N',
      priorityLabel: 'Alta',
      userName: INJECTION,
      userEmail: 'ana@empresa.com',
      organizationName: INJECTION,
      planLabel: 'Profissional',
      subject: INJECTION,
      message: INJECTION,
      dateLabel: '27/08/2026',
    });

    assertEscaped(html);
    expect(html.match(/<img src=x/g)).toBeNull();
  });

  it('support-confirmation: escapa nome, assunto e mensagem do usuário', () => {
    const html = supportConfirmationTemplate({
      userName: INJECTION,
      ticketCode: 'SUP-20260827-7K4N',
      subject: INJECTION,
      message: INJECTION,
      dateLabel: '27/08/2026',
    });

    assertEscaped(html);
    expect(html.match(/<img src=x/g)).toBeNull();
  });
});
