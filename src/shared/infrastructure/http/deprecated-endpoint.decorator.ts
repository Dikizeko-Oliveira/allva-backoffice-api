import { applyDecorators, Header } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

/**
 * Marca uma rota como substituída por outra.
 *
 * **Descontinuar é anunciar, não impedir**: a rota continua funcionando igual.
 * Remover rota pública é mudança coordenada e quebra cliente — este decorator
 * torna a duplicação visível e nomeia a sucessora; a remoção é decisão
 * separada.
 *
 * Emite os três sinais que um cliente consegue observar:
 * - `Deprecation: true` (RFC 8594) em toda resposta;
 * - `Link: <sucessora>; rel="successor-version"`, para a substituta ser
 *   descobrível a partir da própria resposta, não só da documentação;
 * - `deprecated: true` no Swagger, que rende a rota riscada.
 *
 * O BFF do frontend já registra o header (`warnIfDeprecated`), então uma
 * chamada esquecida aparece no log em vez de sobreviver em silêncio — que é a
 * razão de o header importar mais que o comentário no código.
 *
 * > **Não confundir com rota removida.** O que a v2 tirou por violar P1 (§7.4 —
 * > `POST /campaigns` e companhia) **não** está aqui: aquilo não voltou nem foi
 * > substituído por equivalente. Este decorator é para duplicata com sucessora.
 */
export function DeprecatedEndpoint(options: {
  /** Rota canônica que a substitui, ex.: `GET /api/v1/billing/subscription`. */
  replacedBy: string;
  /** Por que a duplicata existiu e o que difere, se algo difere. */
  note?: string;
}) {
  const description =
    `**Descontinuado.** Use \`${options.replacedBy}\`.` +
    (options.note ? `\n\n${options.note}` : '') +
    '\n\nContinua funcionando sem alteração de comportamento; a remoção será ' +
    'anunciada separadamente.';

  return applyDecorators(
    ApiOperation({ deprecated: true, description }),
    Header('Deprecation', 'true'),
    Header('Link', `<${options.replacedBy}>; rel="successor-version"`),
  );
}
