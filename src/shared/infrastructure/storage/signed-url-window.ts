/**
 * A janela de assinatura: um par (assinado em, expira em) **arredondado**, em
 * vez de `agora + ttl`.
 *
 * Toda assinatura carrega o instante em que foi feita, então `agora + ttl`
 * produz uma URL diferente a cada requisição — e URL diferente é **objeto
 * diferente** para o cache do browser. A mesma miniatura seria rebaixada do
 * bucket a cada render de lista, pagando egress e latência que o cache do
 * browser existia justamente para evitar. Numa tela com 50 criativos isso é a
 * diferença entre 50 downloads e zero.
 *
 * Arredondando, toda requisição dentro da mesma janela produz a mesma URL byte
 * a byte, e o browser reaproveita o que já tem.
 *
 * A validade resultante fica entre 1x e 2x o TTL — o piso é o que importa, para
 * que o link nunca chegue quase vencido na mão de quem o recebeu. O teto é o
 * que limita o estrago de uma URL vazada, porque assinada significa "quem tiver
 * o link lê até expirar".
 */
export type SignedUrlWindow = {
  /** Início da janela corrente — o `signingDate` do S3. */
  signedAt: Date;
  /** Fim da janela seguinte — o `expires` do GCS. */
  expiresAt: Date;
};

export function signedUrlWindow(
  ttlSeconds: number,
  now: number = Date.now(),
): SignedUrlWindow {
  const windowMs = ttlSeconds * 1000;
  const start = Math.floor(now / windowMs) * windowMs;

  return {
    signedAt: new Date(start),
    // Duas janelas à frente do início: garante ao menos um TTL inteiro de
    // validade para quem pedir no último segundo da janela corrente.
    expiresAt: new Date(start + 2 * windowMs),
  };
}
