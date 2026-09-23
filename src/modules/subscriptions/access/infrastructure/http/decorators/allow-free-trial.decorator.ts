import { SetMetadata } from '@nestjs/common';

export const ALLOW_FREE_TRIAL_METADATA = 'access:allowFreeTrial';

/**
 * Libera a rota também para quem está no teste gratuito.
 *
 * `@RequireAccessStatuses` compara `accessStatus`, e o teste é `ALLOWED` —
 * indistinguível de uma assinatura paga em dia. Para quase toda rota isso está
 * certo: o teste entrega o produto inteiro. Para a **contratação da primeira
 * assinatura** está exatamente errado, e o efeito era um beco sem saída — o
 * checkout recusava quem estava no teste ("você já assinou, vá trocar de
 * plano"), e a troca de plano recusava a mesma pessoa por não existir
 * assinatura de conta para trocar.
 *
 * Anotar a rota é deliberadamente mais chato do que incluir `ALLOWED` na lista
 * de status: incluir `ALLOWED` abriria a contratação para **quem já paga**,
 * que é uma cobrança em duplicidade esperando para acontecer. Aqui a exceção é
 * nominal, vale só para o teste gratuito, e cada rota que a recebe está
 * dizendo "esta é uma porta de contratação".
 */
export const AllowFreeTrial = () => SetMetadata(ALLOW_FREE_TRIAL_METADATA, true);
