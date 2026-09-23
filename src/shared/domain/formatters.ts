import { currencyExponent } from 'src/shared/domain/money';

/**
 * Mesmo fuso de `scheduler-timezone.ts` (`infrastructure/scheduling`) — e
 * duplicado de propósito, não importado de lá: `domain/` não importa
 * `infrastructure/` (§16.6, imposto por `test/architecture/layering.spec.ts`).
 * Se o produto um dia operar em mais de um fuso de exibição, os dois lugares
 * precisam mudar juntos.
 */
const DISPLAY_TIMEZONE = 'America/Sao_Paulo';

/**
 * Apresentação pt-BR de moeda, número, percentual e data — um lugar só.
 *
 * Antes disto, `report-builder.service.ts` tinha `money()`/`format()` locais
 * (fixos em 2 casas, mesmo para JPY/BHD) mais ~7 `.toFixed()` crus repetindo a
 * mesma regra na mão, e os e-mails formatavam data com um terceiro critério.
 * Um `NaN` (0/0 de um score, por exemplo) passava direto: `value === null`
 * não pega `NaN`, e a string `"NaN"` ia parar no PDF. Todo formatter aqui
 * trata `null`, `undefined`, `NaN` e `Infinity` da mesma forma — "—" — para
 * que nenhum desses vaze para um e-mail ou um relatório baixado.
 */

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Valor monetário em unidade maior, na moeda dada — casas decimais pelo ISO 4217 (§ money.ts). */
export function formatMoneyAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (!isUsableNumber(amount)) return '—';

  const code = currency?.trim().toUpperCase();
  if (!code) return formatNumber(amount);

  const decimals = currencyExponent(code);
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    // `code` não é um ISO 4217 válido para o Intl desta runtime — degrada para
    // número simples com o código na frente em vez de lançar no meio da
    // geração do relatório.
    return `${code} ${formatNumber(amount, decimals)}`;
  }
}

/** Mesma coisa, para o formato `{ valueBase, baseCurrency }` do domínio (money.ts). */
export function formatMoneyView(
  value: { valueBase: number; baseCurrency: string } | null | undefined,
): string {
  if (!value) return '—';
  return formatMoneyAmount(value.valueBase, value.baseCurrency);
}

/** Número simples, separador decimal e milhar pt-BR. */
export function formatNumber(
  value: number | null | undefined,
  decimals = 2,
): string {
  if (!isUsableNumber(value)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Contagem inteira — arredonda em vez de truncar casas que não deveriam existir. */
export function formatInteger(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return '—';
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(
    Math.round(value),
  );
}

/** Percentual com sinal opcional — usado nas variações período-contra-período. */
export function formatPercent(
  value: number | null | undefined,
  opts: { decimals?: number; signed?: boolean } = {},
): string {
  if (!isUsableNumber(value)) return '—';
  const decimals = opts.decimals ?? 1;
  const text = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
  const sign = opts.signed && value >= 0 ? '+' : '';
  return `${sign}${text}%`;
}

function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/** `dd/mm/aaaa`, no fuso do produto (§ scheduler-timezone.ts). */
export function formatDateBR(date: Date | null | undefined): string {
  if (!isValidDate(date)) return '—';
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: DISPLAY_TIMEZONE,
  });
}

/** `dd/mm/aaaa às HH:mm`, no fuso do produto — para instantes, não só dias. */
export function formatDateTimeBR(date: Date | null | undefined): string {
  if (!isValidDate(date)) return '—';
  const day = formatDateBR(date);
  const time = date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIMEZONE,
  });
  return `${day} às ${time}`;
}
