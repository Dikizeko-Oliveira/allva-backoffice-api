import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { ContractDraftsRepositoryInterface } from 'src/modules/contract-drafts/domain/ports';
import { toContractDraftOutput } from '../contract-draft.presenter';
import { ContractDraftOutputDto } from '../dtos';
import { findContractDraft } from '../find-contract-draft';

@Injectable()
export class GetContractDraftUseCase {
  constructor(
    private readonly draftsRepository: ContractDraftsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    id: string,
  ): Promise<ContractDraftOutputDto> {
    assertPlatformPermission(operator, 'billing:read');

    return toContractDraftOutput(
      await findContractDraft(this.draftsRepository, id),
    );
  }
}
