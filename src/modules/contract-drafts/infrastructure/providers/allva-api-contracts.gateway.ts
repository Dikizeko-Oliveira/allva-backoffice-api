import { BadGatewayException, Injectable } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import { ProductContractsGatewayInterface } from 'src/modules/contract-drafts/domain/ports';
import { AllvaApiClient } from 'src/shared/infrastructure/allva-api/allva-api.client';

/** O recorte de `ContractOutputDto` (allva-api) que a conversão usa. */
type ApiContract = { id?: string };

@Injectable()
export class AllvaApiContractsGateway extends ProductContractsGatewayInterface {
  constructor(private readonly allvaApi: AllvaApiClient) {
    super();
  }

  async create(
    operator: Operator,
    terms: unknown,
  ): Promise<{ contractId: string }> {
    const contract = await this.allvaApi.request<ApiContract>(
      '/api/v1/admin/contracts',
      { method: 'POST', token: operator.accessToken, body: terms },
    );

    // Sem id não há como ligar a minuta ao contrato — e gravar a conversão
    // assim deixaria um contrato órfão no produto sem ninguém saber qual.
    if (!contract?.id) {
      throw new BadGatewayException({
        code: 'PRODUCT_API_UNEXPECTED_RESPONSE',
        message: 'allva-api created the contract without returning its id',
      });
    }

    return { contractId: contract.id };
  }
}
