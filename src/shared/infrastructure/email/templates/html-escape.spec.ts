import { escapeHtml } from './html-escape';

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<script>alert('x')</script> & "quotes"`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quotes&quot;',
    );
  });

  it('is a no-op for text with no special characters', () => {
    expect(escapeHtml('Ana Beatriz')).toBe('Ana Beatriz');
  });

  it('accepts a number without throwing', () => {
    expect(escapeHtml(15)).toBe('15');
  });

  it('neutralizes a business message that happens to contain "<" without any malicious intent', () => {
    // O caso comum que motivou o escaping: "ROAS < 1.5" quebrava a marcação
    // do e-mail mesmo sem ninguém tentar nada — < vira o início de uma tag.
    expect(escapeHtml('ROAS < 1.5 nas últimas 48h')).toBe(
      'ROAS &lt; 1.5 nas últimas 48h',
    );
  });
});
