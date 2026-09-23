import { Transform } from 'class-transformer';

/**
 * Normalizes a free-text input: trims surrounding whitespace, drops control
 * characters (including null bytes) and removes angle brackets to neutralize
 * stored-HTML/XSS payloads. Non-string values are passed through untouched.
 */
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

/**
 * Like {@link sanitizeString} but preserves newlines/tabs so multi-line message
 * bodies keep their formatting. Other control characters are still stripped.
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

function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export function SanitizeText() {
  return Transform(({ value }: { value: unknown }) => sanitizeString(value));
}

export function SanitizeMultiline() {
  return Transform(({ value }: { value: unknown }) => sanitizeMultiline(value));
}

export function SanitizeEmail() {
  return Transform(({ value }: { value: unknown }) => normalizeEmail(value));
}
