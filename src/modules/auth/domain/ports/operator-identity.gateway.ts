import type { Operator } from '../entities';

/**
 * O que o `allva-api` disse sobre um bearer token.
 *
 * - `OPERATOR`: conta de plataforma, com as permissões resolvidas.
 * - `NOT_OPERATOR`: sessão válida de conta de cliente (`platformRole: null`).
 * - `UNAUTHENTICATED`: token inválido, expirado ou sessão revogada.
 * - `UNAVAILABLE`: não deu para perguntar. **Não é** "não autenticado" — o
 *   operador não está deslogado, quem falhou foi a dependência.
 */
export type OperatorIdentityResult =
  | { status: 'OPERATOR'; operator: Operator }
  | { status: 'NOT_OPERATOR' }
  | { status: 'UNAUTHENTICATED' }
  | { status: 'UNAVAILABLE' };

export abstract class OperatorIdentityGatewayInterface {
  abstract introspect(accessToken: string): Promise<OperatorIdentityResult>;
}
