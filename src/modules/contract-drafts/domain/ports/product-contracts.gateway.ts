import type { Operator } from 'src/modules/auth/domain/entities';

/**
 * Onde o contrato de verdade nasce: `POST /api/v1/admin/contracts` do
 * `allva-api`, em nome do operador. O produto valida os termos e aplica as
 * próprias permissões.
 */
export abstract class ProductContractsGatewayInterface {
  abstract create(
    operator: Operator,
    terms: unknown,
  ): Promise<{ contractId: string }>;
}
