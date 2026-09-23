import {
  BLOCK_GAP,
  COLORS,
  CTA_GAP,
  FONT_STACK,
  MONO_FONT_STACK,
  TONES,
  type EmailTone,
} from './theme';

/**
 * Os blocos de conteúdo dos e-mails da Allva.
 *
 * **Convenção de escaping:** nenhum componente escapa nada. Todo parâmetro
 * chamado `html` recebe marcação já pronta, e todo dado vindo do domínio
 * (nome de conta, assunto de chamado, diagnóstico de desperdício) tem que
 * passar por `escapeHtml` no template que o interpola. É a mesma disciplina que
 * os templates já seguiam antes do design system, e é o que os testes de
 * injeção em `templates.spec.ts` verificam — centralizar o escaping aqui
 * esconderia de quem lê o template a pergunta "este dado é confiável?".
 *
 * Tudo é tabela com estilo inline porque cliente de e-mail não tem cascata
 * confiável: `<style>` no `<head>` é descartado por parte deles, e flexbox e
 * grid não existem no Outlook, que renderiza com o motor do Word.
 */

/** Título principal do e-mail. A classe existe para o media query do layout. */
export function heading(html: string): string {
  return `
                <h1 class="allva-h1" style="margin:0 0 20px 0;color:${COLORS.black};font-size:38px;line-height:1.15;font-weight:700;letter-spacing:-1px;">
                  ${html}
                </h1>`;
}

/** Subtítulo de uma seção interna (ex.: "Principais desperdícios"). */
export function sectionTitle(html: string): string {
  return `
                <h2 style="margin:0 0 12px 0;color:${COLORS.black};font-size:16px;line-height:1.35;font-weight:700;">
                  ${html}
                </h2>`;
}

type ParagraphOptions = {
  /** `lead` é o parágrafo de abertura, um ponto maior que o corpo. */
  variant?: 'lead' | 'body' | 'small';
  marginTop?: number;
  marginBottom?: number;
  align?: 'left' | 'center';
};

export function paragraph(
  html: string,
  options: ParagraphOptions = {},
): string {
  const {
    variant = 'body',
    marginTop = 0,
    marginBottom = BLOCK_GAP,
    align = 'left',
  } = options;

  const scale = {
    lead: { size: 17, color: COLORS.text, lineHeight: 1.6 },
    body: { size: 16, color: COLORS.textMuted, lineHeight: 1.7 },
    small: { size: 13, color: COLORS.textFaint, lineHeight: 1.6 },
  }[variant];

  return `
                <p style="margin:${marginTop}px 0 ${marginBottom}px 0;color:${scale.color};font-size:${scale.size}px;line-height:${scale.lineHeight};text-align:${align};">
                  ${html}
                </p>`;
}

/** "Olá <nome>," — o nome em destaque, na cor de acento. */
export function greeting(nameHtml: string): string {
  return paragraph(
    `Olá <strong style="color:${COLORS.accent};">${nameHtml}</strong>,`,
    { variant: 'lead' },
  );
}

/** Pílula acima do título, com o assunto do e-mail em uma palavra. */
export function badge(label: string, tone: EmailTone = 'accent'): string {
  const { text, soft } = TONES[tone];

  return `
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${BLOCK_GAP}px 0;">
                  <tr>
                    <td style="background:${soft};border-radius:10px;padding:10px 16px;">
                      <span style="color:${text};font-size:14px;font-weight:700;line-height:1;">${label}</span>
                    </td>
                  </tr>
                </table>`;
}

/**
 * O botão principal. Só um por e-mail — dois CTAs concorrentes fazem a pessoa
 * escolher em vez de agir.
 */
export function ctaButton(
  label: string,
  url: string,
  tone: 'accent' | 'destructive' = 'accent',
): string {
  const background = tone === 'accent' ? COLORS.accent : COLORS.destructiveText;

  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:${CTA_GAP - BLOCK_GAP}px 0 0 0;">
                  <tr>
                    <td align="center">
                      <a href="${url}" target="_blank" style="display:inline-block;background:${background};color:${COLORS.white};text-decoration:none;font-size:17px;line-height:1;font-weight:700;padding:17px 30px;border-radius:10px;">
                        ${label}
                      </a>
                    </td>
                  </tr>
                </table>`;
}

/**
 * O link em texto, para quando o botão não abre.
 *
 * Existe porque parte dos clientes corporativos reescreve ou bloqueia o href do
 * botão; sem esta caixa, o e-mail vira um beco sem saída.
 */
export function fallbackLink(url: string, urlLabel = url): string {
  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:${CTA_GAP}px;background:${COLORS.accentSoft};border-radius:12px;">
                  <tr>
                    <td valign="middle" style="padding:18px 20px;">
                      <p style="margin:0 0 5px 0;color:${COLORS.textMuted};font-size:13px;line-height:1.5;">
                        Se o botão não funcionar, copie e cole este link no navegador:
                      </p>
                      <a href="${url}" target="_blank" style="color:${COLORS.accent};text-decoration:none;font-size:14px;font-weight:600;word-break:break-all;">${urlLabel}</a>
                    </td>
                  </tr>
                </table>`;
}

export type FeatureItem = {
  /** Glifo ou emoji — o ícone é decorativo e não carrega informação sozinho. */
  icon: string;
  title: string;
  description: string;
};

/** Grade de três colunas que empilha no celular (ver o media query do layout). */
export function featureGrid(items: FeatureItem[]): string {
  const width = (100 / items.length).toFixed(2);

  const cells = items
    .map(
      (item) => `
                    <td class="allva-stack" width="${width}%" valign="top" align="center" style="padding:26px 12px;">
                      <div style="width:52px;height:52px;line-height:52px;margin:0 auto 14px auto;background:${COLORS.white};border-radius:26px;color:${COLORS.accent};font-size:22px;text-align:center;">${item.icon}</div>
                      <p style="margin:0 0 8px 0;color:${COLORS.black};font-size:14px;line-height:1.35;font-weight:700;">${item.title}</p>
                      <p style="margin:0;color:${COLORS.textMuted};font-size:13px;line-height:1.55;">${item.description}</p>
                    </td>`,
    )
    .join('');

  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 ${BLOCK_GAP}px 0;background:${COLORS.accentSoft};border-radius:14px;">
                  <tr>${cells}
                  </tr>
                </table>`;
}

export type InfoRow = { label: string; value: string };

/** Card de metadados — chamado, plano, organização, valor de assinatura. */
export function infoCard(rows: InfoRow[]): string {
  const lines = rows
    .map(
      (row) =>
        `<tr>
                        <td style="padding:3px 0;color:${COLORS.textFaint};font-size:13px;line-height:1.7;white-space:nowrap;">${row.label}</td>
                        <td style="padding:3px 0 3px 14px;color:${COLORS.text};font-size:13px;line-height:1.7;font-weight:600;">${row.value}</td>
                      </tr>`,
    )
    .join('\n                      ');

  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${BLOCK_GAP}px 0;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:12px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      ${lines}
                      </table>
                    </td>
                  </tr>
                </table>`;
}

/**
 * Bloco destacado com barra lateral colorida: a mensagem de um alerta, o texto
 * que o usuário mandou para o suporte, o motivo de uma falha.
 */
export function callout(
  html: string,
  tone: EmailTone = 'accent',
  options: { label?: string; preserveLineBreaks?: boolean } = {},
): string {
  const { text, soft } = TONES[tone];
  const whiteSpace = options.preserveLineBreaks ? 'white-space:pre-wrap;' : '';

  const label = options.label
    ? `<p style="margin:0 0 6px 0;color:${COLORS.textFaint};font-size:12px;line-height:1.5;">${options.label}</p>`
    : '';

  return `
                ${label}
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${BLOCK_GAP}px 0;background:${soft};border-left:3px solid ${text};border-radius:8px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0;color:${COLORS.text};font-size:15px;line-height:1.65;${whiteSpace}">${html}</p>
                    </td>
                  </tr>
                </table>`;
}

/** O código de verificação, em monoespaçada e com espaçamento entre dígitos. */
export function codeBlock(code: string): string {
  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 ${BLOCK_GAP}px 0;">
                  <tr>
                    <td align="center">
                      <span style="display:inline-block;background:${COLORS.surfaceAlt};border:1px solid ${COLORS.border};border-radius:12px;padding:18px 26px;font-family:${MONO_FONT_STACK};font-size:34px;font-weight:700;letter-spacing:10px;color:${COLORS.black};">${code}</span>
                    </td>
                  </tr>
                </table>`;
}

export type Stat = { value: string; label: string; tone: EmailTone };

/** Três números lado a lado — o formato do resumo diário. */
export function statGrid(stats: Stat[]): string {
  const width = (100 / stats.length).toFixed(2);

  const cells = stats
    .map((stat) => {
      const { text, soft } = TONES[stat.tone];

      return `
                    <td class="allva-stack" width="${width}%" valign="top" align="center" style="padding:6px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${soft};border-radius:12px;">
                        <tr>
                          <td align="center" style="padding:18px 8px;">
                            <div style="color:${text};font-size:28px;line-height:1.1;font-weight:700;">${stat.value}</div>
                            <div style="margin-top:6px;color:${COLORS.textMuted};font-size:12px;line-height:1.4;">${stat.label}</div>
                          </td>
                        </tr>
                      </table>
                    </td>`;
    })
    .join('');

  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${BLOCK_GAP}px 0;">
                  <tr>${cells}
                  </tr>
                </table>`;
}

export type ListRowItem = {
  title: string;
  /** Etiqueta curta à direita do título (prioridade, status). */
  tag?: { label: string; tone: EmailTone };
  description: string;
  meta?: string;
};

/** Lista de itens com título, etiqueta e descrição — os desperdícios do dia. */
export function listRows(items: ListRowItem[]): string {
  const rows = items
    .map((item) => {
      const tag = item.tag
        ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:6px;background:${TONES[item.tag.tone].soft};color:${TONES[item.tag.tone].text};font-size:11px;font-weight:700;line-height:1.6;">${item.tag.label}</span>`
        : '';

      const meta = item.meta
        ? `<div style="margin-top:4px;color:${COLORS.textFaint};font-size:12px;line-height:1.5;">${item.meta}</div>`
        : '';

      return `
                  <tr>
                    <td style="padding:12px 0;border-bottom:1px solid ${COLORS.border};">
                      <div style="margin-bottom:4px;">
                        <span style="color:${COLORS.black};font-size:14px;font-weight:700;">${item.title}</span>${tag}
                      </div>
                      <div style="color:${COLORS.textMuted};font-size:13px;line-height:1.6;">${item.description}</div>
                      ${meta}
                    </td>
                  </tr>`;
    })
    .join('');

  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 ${BLOCK_GAP}px 0;">${rows}
                </table>`;
}

/** Nota de rodapé do corpo, com ícone em círculo — preferências, avisos. */
export function noteRow(icon: string, html: string): string {
  return `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:${BLOCK_GAP}px;">
                  <tr>
                    <td width="44" valign="top" align="center">
                      <div style="width:36px;height:36px;line-height:36px;background:${COLORS.surfaceAlt};border-radius:18px;color:${COLORS.textMuted};font-size:16px;text-align:center;">${icon}</div>
                    </td>
                    <td valign="middle" style="padding-left:12px;">
                      <p style="margin:0;color:${COLORS.textFaint};font-size:13px;line-height:1.6;">${html}</p>
                    </td>
                  </tr>
                </table>`;
}

/** Link inline no corpo do texto, na cor de acento. */
export function inlineLink(url: string, label: string): string {
  return `<a href="${url}" target="_blank" style="color:${COLORS.accent};text-decoration:none;font-weight:600;">${label}</a>`;
}

/** Trecho em negrito dentro de um parágrafo. */
export function strongText(html: string): string {
  return `<strong style="color:${COLORS.black};">${html}</strong>`;
}

export { COLORS, FONT_STACK, TONES };
