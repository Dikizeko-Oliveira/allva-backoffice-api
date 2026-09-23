import { badge as renderBadge, heading as renderHeading } from './components';
import {
  COLORS,
  CONTAINER_WIDTH,
  FONT_STACK,
  emailLogoMarcaUrl,
  emailLogoUrl,
  type EmailTone,
} from './theme';

/**
 * O envelope comum a todos os e-mails: `<head>`, preheader, cabeçalho com a
 * logo, o corpo e o rodapé. Um template só descreve o que muda — badge, título
 * e blocos de conteúdo.
 *
 * Nada aqui escapa conteúdo; ver a convenção em `components.ts`.
 */

/**
 * Redes sociais do rodapé. Vazio de propósito: o modelo previa os ícones, mas
 * `href="#"` em e-mail é link morto — filtro de spam pontua isso e o leitor
 * clica em nada. Preencher a lista liga a linha inteira no rodapé.
 */
export const SOCIAL_LINKS: Array<{ label: string; url: string }> = [];

export type EmailDocumentProps = {
  /** Vira o `<title>` — em vários clientes é o que aparece ao imprimir. */
  title: string;
  /** A linha de preview na caixa de entrada, antes de abrir o e-mail. */
  preheader: string;
  /** Pílula acima do título. */
  badge?: { label: string; tone?: EmailTone };
  heading: string;
  /** Os blocos do corpo, já montados com os componentes. */
  content: string;
  /** Linha discreta acima do copyright (cancelamento, aviso de resposta). */
  footerNote?: string;
  /**
   * Texto extra ao lado do wordmark no cabeçalho, ex. "Suporte". Ausente na
   * maioria dos e-mails, que mostram só o ícone e o wordmark da marca;
   * e-mails internos (a caixa do suporte) usam isso para se distinguir na
   * lista.
   */
  headerLabel?: string;
};

/**
 * O espaçador de preheader impede que o cliente de e-mail complete a linha de
 * preview com o começo do corpo ("Olá Ana, ..."). São caracteres invisíveis,
 * não espaços — espaço em branco é colapsado antes de chegar à caixa.
 */
const PREHEADER_SPACER = '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;'.repeat(20);

export function renderEmail(props: EmailDocumentProps): string {
  const { title, preheader, badge, heading, content, footerNote, headerLabel } =
    props;

  const logo = emailLogoUrl();
  const logoMarca = emailLogoMarcaUrl();

  const badgeBlock = badge
    ? renderBadge(badge.label, badge.tone ?? 'accent')
    : '';

  const headerLabelBlock = headerLabel
    ? `<span style="display:inline-block;vertical-align:middle;margin-left:8px;color:${COLORS.textMuted};font-size:19px;font-weight:700;letter-spacing:-0.3px;">— ${headerLabel}</span>`
    : '';

  return `
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${title}</title>
    <style>
      /*
       * Progressivo: quem descarta <style> (parte do Gmail) fica com o layout
       * inline, que já é legível no celular — o media query só alivia o
       * respiro lateral e empilha as grades de 3 colunas.
       */
      @media only screen and (max-width: 600px) {
        .allva-pad { padding-left: 22px !important; padding-right: 22px !important; }
        .allva-h1 { font-size: 28px !important; letter-spacing: -0.5px !important; }
        .allva-stack { display: block !important; width: 100% !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${COLORS.canvas};font-family:${FONT_STACK};color:${COLORS.text};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}${PREHEADER_SPACER}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.canvas};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:${CONTAINER_WIDTH}px;background:${COLORS.white};border-radius:16px;overflow:hidden;">
            <tr>
              <td class="allva-pad" style="padding:20px 40px;background:${COLORS.white};">
                <img src="${logo}" width="40" height="39" alt="" style="display:inline-block;vertical-align:middle;border:0;outline:none;margin-right:10px;" />
                <img src="${logoMarca}" width="76" height="24" alt="Allva" style="display:inline-block;vertical-align:middle;border:0;outline:none;" />${headerLabelBlock}
              </td>
            </tr>
            <tr>
              <td class="allva-pad" style="padding:10px 40px 38px 40px;">${badgeBlock}${renderHeading(heading)}${content}
              </td>
            </tr>
            ${renderFooter(footerNote)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

/**
 * O rodapé leva só o wordmark, sem o ícone. A logo da Allva é clara (turquesa
 * sobre transparente): a 40px no cabeçalho ela se sustenta sobre o branco, mas
 * nos 26px daqui vira um borrão claro que só suja a linha de assinatura.
 */
function renderFooter(note?: string): string {
  const noteBlock = note
    ? `
                  <tr>
                    <td colspan="2" style="padding-top:18px;">
                      <p style="margin:0;color:${COLORS.textFaint};font-size:12px;line-height:1.6;">${note}</p>
                    </td>
                  </tr>`
    : '';

  const social = SOCIAL_LINKS.length
    ? `
                    <td valign="middle" align="right">${SOCIAL_LINKS.map(
                      (link) => `
                      <a href="${link.url}" target="_blank" style="display:inline-block;width:36px;height:36px;line-height:36px;margin-left:6px;background:${COLORS.surfaceAlt};border-radius:18px;color:${COLORS.textMuted};text-align:center;text-decoration:none;font-size:13px;font-weight:700;">${link.label}</a>`,
                    ).join('')}
                    </td>`
    : '';

  return `<tr>
              <td class="allva-pad" style="padding:24px 40px 30px 40px;border-top:1px solid ${COLORS.border};background:${COLORS.white};">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td valign="middle" align="left">
                      <span style="display:inline-block;vertical-align:middle;color:${COLORS.black};font-size:19px;font-weight:700;letter-spacing:-0.3px;">Allva</span>
                    </td>${social}
                  </tr>${noteBlock}
                  <tr>
                    <td colspan="2" style="padding-top:16px;">
                      <p style="margin:0;color:${COLORS.textFaint};font-size:12px;line-height:1.6;">
                        © ${new Date().getFullYear()} Allva. Todos os direitos reservados.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;
}
