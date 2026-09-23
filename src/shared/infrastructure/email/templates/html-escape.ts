const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapa um valor antes de entrar num template HTML de e-mail.
 *
 * Nome de conta, nome de organização e título/mensagem de alerta chegam aqui
 * como texto de negócio, não como HTML de confiança — e mesmo sem intenção
 * maliciosa, um diagnóstico do tipo "ROAS < 1.5" sem escape já quebra a
 * marcação da mensagem. A regra aplicada nos templates é simples de auditar:
 * todo `${props.*}` interpolado no HTML passa por aqui, sem exceção por
 * campo — inclusive URL e número, onde escapar não muda nada — porque manter
 * uma lista de "quais campos são seguros e por quê" é o tipo de lista que
 * envelhece mal.
 */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
