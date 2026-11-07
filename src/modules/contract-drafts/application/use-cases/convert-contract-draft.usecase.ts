import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  ContractDraftsRepositoryInterface,
  ProductContractsGatewayInterface,
} from 'src/modules/contract-drafts/domain/ports';
import { toContractDraftOutput } from '../contract-draft.presenter';
import { ContractDraftOutputDto } from '../dtos';
import { findContractDraft } from '../find-contract-draft';

/**
 * A chave com que a minuta pede o contrato ao produto. Derivada do id, e só
 * dele: toda tentativa de converter a mesma minuta é o mesmo pedido.
 */
export function contractDraftIdempotencyKey(draftId: string): string {
  return `contract-draft:${draftId}`;
}

/**
 * Cria o contrato no `allva-api` a partir da minuta.
 *
 * Idempotente nos três casos (GAP-043):
 *
 * - **Em série:** minuta já convertida devolve o estado atual sem chamar o
 *   produto de novo.
 * - **Em paralelo:** as duas conversões mandam a mesma `Idempotency-Key`, o
 *   produto cria um contrato só e devolve o mesmo id às duas; a gravação aqui é
 *   condicional (`saveConversion`) e só a primeira audita.
 * - **Falha parcial:** se o contrato nasceu e a resposta não chegou, ou a
 *   gravação local falhou, a nova tentativa recebe o mesmo `contractId`.
 *
 * Termos editados entre uma tentativa que criou o contrato e a seguinte dão
 * 409 `IDEMPOTENCY_KEY_REUSED` no produto: o contrato com os termos antigos
 * existe, e criar outro em silêncio deixaria o primeiro órfão.
 */
@Injectable()
export class ConvertContractDraftUseCase {
  constructor(
    private readonly draftsRepository: ContractDraftsRepositoryInterface,
    private readonly productContracts: ProductContractsGatewayInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
  ): Promise<ContractDraftOutputDto> {
    assertPlatformPermission(operator, 'billing:manage');

    const draft = await findContractDraft(this.draftsRepository, id);

    if (draft.isConverted) return toContractDraftOutput(draft);

    const before = toContractDraftOutput(draft);
    const { contractId } = await this.productContracts.create(
      operator,
      draft.terms,
      contractDraftIdempotencyKey(draft.id),
    );

    draft.markConverted(contractId);

    if (!(await this.draftsRepository.saveConversion(draft))) {
      // Outra conversão gravou antes, com o mesmo contrato: ela já auditou.
      return toContractDraftOutput(
        await findContractDraft(this.draftsRepository, id),
      );
    }

    const after = toContractDraftOutput(draft);

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.converted',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: id,
      before,
      after,
    });

    return after;
  }
}
