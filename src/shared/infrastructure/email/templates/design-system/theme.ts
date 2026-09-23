/**
 * Tokens visuais dos e-mails da Allva.
 *
 * As cores da marca são definidas em `oklch` no frontend; aqui elas estão em
 * hexadecimal porque **nenhum cliente de e-mail relevante entende `oklch`** — o
 * Outlook e o Gmail descartam a declaração inteira e o elemento cai para a cor
 * herdada. A conversão foi feita uma vez (oklch → sRGB) e o valor original está
 * anotado ao lado de cada token, para que a origem continue rastreável.
 *
 * Onde há duas variantes da mesma cor, a razão é contraste: `success`,
 * `warning` e `destructive` nas versões da marca ficam entre 2:1 e 3.8:1 sobre
 * branco — suficiente para preencher um fundo, insuficiente para texto. As
 * variantes `*Text` são a mesma matiz escurecida até passar de 4.5:1 (WCAG AA).
 */

/** Cores da marca, convertidas de oklch para hex. */
export const COLORS = {
  /** oklch(0.764 0.0972 192.79) — turquesa da marca. */
  primary: '#5dc6c3',
  /** Mesma matiz escurecida para uso em texto (4.60:1 sobre branco). */
  primaryText: '#008381',
  /** oklch(0.7123 0.0855 238.8) — azul claro de apoio. */
  secondary: '#6eaad2',
  /** oklch(0.54 0.15 238.8) — o azul dos botões primários do app (4.82:1 com texto branco). */
  accent: '#0077bb',
  /** oklch(0.645 0.246 16.439). */
  destructive: '#ff2056',
  destructiveText: '#eb0047',
  /** oklch(0.696 0.17 162.48). */
  success: '#00bc7d',
  successText: '#00884d',
  /** oklch(0.769 0.188 70.08). */
  warning: '#fe9a00',
  warningText: '#ba5a00',
  /** O preto da marca — fundo do cabeçalho e cor dos títulos. */
  black: '#09090b',

  /** Fundos claros de cada tom, para badges, cards e callouts. */
  accentSoft: '#ebf4fa',
  primarySoft: '#f2fafa',
  destructiveSoft: '#ffedf1',
  successSoft: '#ebfaf5',
  warningSoft: '#fff7eb',

  /**
   * Neutros da família zinc — a mesma que gera o `#09090b` da marca. Slate (o
   * cinza do modelo original) puxa para azul e brigava com o preto neutro.
   */
  text: '#27272a',
  textMuted: '#52525b',
  textFaint: '#71717a',
  border: '#e4e4e7',
  surface: '#fafafa',
  surfaceAlt: '#f4f4f5',
  canvas: '#f4f4f5',
  white: '#ffffff',
} as const;

/**
 * Tons semânticos. Um tom é sempre o par (cor de texto legível, fundo claro) —
 * quem escolhe "warning" não precisa lembrar qual das duas variantes usar.
 */
export const TONES = {
  accent: {
    text: COLORS.accent,
    soft: COLORS.accentSoft,
    solid: COLORS.accent,
  },
  primary: {
    text: COLORS.primaryText,
    soft: COLORS.primarySoft,
    solid: COLORS.primary,
  },
  success: {
    text: COLORS.successText,
    soft: COLORS.successSoft,
    solid: COLORS.success,
  },
  warning: {
    text: COLORS.warningText,
    soft: COLORS.warningSoft,
    solid: COLORS.warning,
  },
  destructive: {
    text: COLORS.destructiveText,
    soft: COLORS.destructiveSoft,
    solid: COLORS.destructive,
  },
  neutral: {
    text: COLORS.textMuted,
    soft: COLORS.surfaceAlt,
    solid: COLORS.textMuted,
  },
} as const;

export type EmailTone = keyof typeof TONES;

/** Arial em primeiro lugar porque é a única presente em todo cliente de e-mail. */
export const FONT_STACK = 'Arial,Helvetica,sans-serif';
export const MONO_FONT_STACK = "'Courier New',Courier,monospace";

/** Largura do card central. O modelo usa 620px; abaixo disso a grade de 3 colunas aperta. */
export const CONTAINER_WIDTH = 620;

/**
 * O respiro entre dois blocos do corpo.
 *
 * Cada bloco carrega a própria margem **inferior** e nenhuma superior — com as
 * duas, clientes que não colapsam margem (a maioria) somariam as duas e o
 * espaçamento variaria conforme o par de blocos vizinhos.
 */
export const BLOCK_GAP = 22;

/**
 * O respiro em volta do botão principal, um pouco maior que entre blocos comuns.
 *
 * O botão só acrescenta a diferença (`CTA_GAP - BLOCK_GAP`) por cima, porque o
 * bloco anterior já contribuiu com `BLOCK_GAP`. É isso que mantém a distância
 * igual em todos os templates, sendo o bloco anterior um card de benefícios, um
 * callout de alerta ou um parágrafo.
 */
export const CTA_GAP = 26;

const DEFAULT_LOGO_URL = 'https://allva.com.br/assets/logos/large.png';
const DEFAULT_LOGO_MARCA_URL =
  'https://allva.com.br/assets/logos/logo-marca.svg';

/**
 * A logo, servida pelo site institucional.
 *
 * Lida de `process.env` em vez de `EnvService` porque os templates são funções
 * puras, sem injeção de dependência — passar a URL como prop obrigaria toda
 * chamada de e-mail do sistema a carregá-la. A variável está declarada em
 * `env.ts` para não repetir o caso do antigo `APP_URL` (indeclarada, invisível
 * na validação de boot); o `default` aqui é seguro por um motivo que não valia
 * para aquele: a logo é a mesma em todos os ambientes, então cair no valor
 * padrão nunca aponta o e-mail para o ambiente errado.
 *
 * É função, e não constante, para que o valor seja lido no envio e não no
 * import — do contrário um teste que ajusta `process.env` não teria efeito.
 */
export function emailLogoUrl(): string {
  return process.env.EMAIL_LOGO_URL?.trim() || DEFAULT_LOGO_URL;
}

/**
 * O wordmark "Allva" ao lado do ícone no cabeçalho — mesma peça (`logo-marca.svg`)
 * que o frontend usa junto do ícone em `AppPublicLogo`. Existe como imagem, e
 * não como `"Allva"` escrito em HTML, para o e-mail reproduzir a tipografia
 * customizada da marca em vez da fonte do cliente de e-mail. Mesmas regras de
 * leitura de `emailLogoUrl` acima.
 */
export function emailLogoMarcaUrl(): string {
  return process.env.EMAIL_LOGO_MARCA_URL?.trim() || DEFAULT_LOGO_MARCA_URL;
}
