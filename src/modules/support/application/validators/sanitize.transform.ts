import { Transform } from 'class-transformer';

/**
 * Cópia deliberada de `contacts`/`sales-leads`: cada módulo público carrega o
 * próprio sanitizador em vez de importar de um módulo de feature vizinho.
 *
 * Remove caracteres de controle (inclusive null byte) e colchetes angulares —
 * a segunda camada de defesa contra HTML/XSS armazenado, depois de
 * `escapeHtml` no template. Preserva quebras de linha para o corpo da
 * mensagem manter a formatação.
 */
function sanitizeMultiline(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isAllowedWhitespace = char === '\n' || char === '\t';
    const isControl = !isAllowedWhitespace && (code < 0x20 || code === 0x7f);
    const isAngleBracket = char === '<' || char === '>';
    if (!isControl && !isAngleBracket) {
      out += char;
    }
  }

  return out.trim();
}

function sanitizeString(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || code === 0x7f;
    const isAngleBracket = char === '<' || char === '>';
    if (!isControl && !isAngleBracket) {
      out += char;
    }
  }

  return out.trim();
}

export function SanitizeText() {
  return Transform(({ value }: { value: unknown }) => sanitizeString(value));
}

export function SanitizeMultiline() {
  return Transform(({ value }: { value: unknown }) => sanitizeMultiline(value));
}
