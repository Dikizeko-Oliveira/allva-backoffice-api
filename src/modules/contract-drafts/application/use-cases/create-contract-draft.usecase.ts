import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { ContractDraft } from 'src/modules/contract-drafts/domain/entities';
import { ContractDraftsRepositoryInterface } from 'src/modules/contract-drafts/domain/ports';
import { toContractDraftOutput } from '../contract-draft.presenter';
import { ContractDraftOutputDto, CreateContractDraftInputDto } from '../dtos';

@Injectable()
export class CreateContractDraftUseCase {
  constructor(
    private readonly draftsRepository: ContractDraftsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: CreateContractDraftInputDto,
  ): Promise<ContractDraftOutputDto> {
    assertPlatformPermission(operator, 'billing:manage');

    const draft = ContractDraft.create({ ...input, createdBy: operator.id });
    await this.draftsRepository.save(draft);

    const output = toContractDraftOutput(draft);

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.created',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: draft.id,
      after: output,
    });

    return output;
  }
}
