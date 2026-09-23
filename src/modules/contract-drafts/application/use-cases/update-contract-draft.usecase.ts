import { ConflictException, Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { ContractDraftsRepositoryInterface } from 'src/modules/contract-drafts/domain/ports';
import { toContractDraftOutput } from '../contract-draft.presenter';
import { ContractDraftOutputDto, UpdateContractDraftInputDto } from '../dtos';
import { findContractDraft } from '../find-contract-draft';

@Injectable()
export class UpdateContractDraftUseCase {
  constructor(
    private readonly draftsRepository: ContractDraftsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
    input: UpdateContractDraftInputDto,
  ): Promise<ContractDraftOutputDto> {
    assertPlatformPermission(operator, 'billing:manage');

    const draft = await findContractDraft(this.draftsRepository, id);

    // Depois da conversão o contrato é do produto. Mexer na minuta faria as
    // duas cópias dos termos divergirem em silêncio.
    if (draft.isConverted) {
      throw new ConflictException({
        code: 'CONTRACT_DRAFT_ALREADY_CONVERTED',
        message: 'Contract draft was already converted into a contract',
        details: { contractId: draft.contractId },
      });
    }

    const before = toContractDraftOutput(draft);

    draft.update(input);
    await this.draftsRepository.update(draft);

    const after = toContractDraftOutput(draft);

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.updated',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: id,
      before,
      after,
    });

    return after;
  }
}
