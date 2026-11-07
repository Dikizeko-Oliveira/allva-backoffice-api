import type { Operator } from 'src/modules/auth/domain/entities';

/**
 * Onde o contrato de verdade nasce: `POST /api/v1/admin/contracts` do
 * `allva-api`, em nome do operador. O produto valida os termos e aplica as
 * próprias permissões.
 *
 * `idempotencyKey` vai como `Idempotency-Key`: o produto devolve o mesmo
 * contrato a um pedido repetido com a mesma chave e os mesmos termos, e 409
 * `IDEMPOTENCY_KEY_REUSED` à mesma chave com outros termos (GAP-043).
 */
export abstract class ProductContractsGatewayInterface {
  abstract create(
    operator: Operator,
    terms: unknown,
    idempotencyKey: string,
  ): Promise<{ contractId: string }>;
}
