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
 * Cria o contrato no `allva-api` a partir da minuta.
 *
 * Idempotente pelo lado de cá: minuta já convertida devolve o estado atual sem
 * chamar o produto de novo — um duplo clique não cria dois contratos.
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
    );

    draft.markConverted(contractId);
    await this.draftsRepository.update(draft);

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
