import { SetMetadata } from '@nestjs/common';

export const RESPONSE_ENVELOPE_METADATA = 'allva:response-envelope';

export type ResponseEnvelopeOptions = {
  /**
   * Rota de inteligência: devolve número derivado (score, waste, recomendação,
   * agregado). O interceptor cobra `asOf` + `provenance` dela, porque é
   * exatamente aí que P7 se aplica. Uma listagem de contexto (`/campaigns`) é
   * envelopada mas não deriva nada, e não tem procedência a declarar.
   */
  intelligence?: boolean;
};

/**
 * Marca uma rota (ou um controller inteiro) como pertencente à superfície §7.0:
 * resposta `{ data, meta }`, erro tipado, cursor.
 *
 * É opt-in, e isso é deliberado. Envelopar globalmente reescreveria o contrato
 * de ~25 módulos que já estão em produção — o front-end quebraria inteiro num
 * commit de infraestrutura. A superfície ads-first nasce envelopada; a legada
 * migra quando for reescrita, e o harness em `test/architecture` impede que
 * rota **nova** de inteligência nasça sem o marcador.
 */
export const ResponseEnvelope = (options: ResponseEnvelopeOptions = {}) =>
  SetMetadata(RESPONSE_ENVELOPE_METADATA, options);

/** Atalho para o caso comum: rota que devolve número derivado. */
export const IntelligenceRoute = () => ResponseEnvelope({ intelligence: true });
