import { RESPONSE_ENVELOPE_METADATA } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import type { ResponseEnvelopeOptions } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { AdActionsController } from './ad-actions.controller';

/**
 * O controller envelopa (§7.0) e **não** se declara rota de inteligência.
 *
 * P7 cobra `meta.provenance` de quem devolve número derivado, e nada aqui
 * devolve: capacidade, intenção aceita e estado de execução não têm janela nem
 * versão de algoritmo. Enquanto a classe carregava `@IntelligenceRoute()`, o
 * `ResponseEnvelopeInterceptor` derrubava **todas** as rotas com `500` fora de
 * produção - o handler terminava bem e a resposta morria no interceptor.
 *
 * O teste é sobre o metadado, e não sobre uma rota, porque o decorator é da
 * classe: uma troca de volta quebraria as cinco de uma vez.
 */
describe('AdActionsController — envelope sem cobrança de P7', () => {
  const options = Reflect.getMetadata(
    RESPONSE_ENVELOPE_METADATA,
    AdActionsController,
  ) as ResponseEnvelopeOptions | undefined;

  it('declara o envelope §7.0', () => {
    expect(options).toBeDefined();
  });

  it('não se declara rota de inteligência', () => {
    // `intelligence: true` aqui volta a exigir `meta.provenance` de respostas
    // que não têm número derivado a proceder - e derruba o controller inteiro.
    expect(options?.intelligence).toBeFalsy();
  });
});
