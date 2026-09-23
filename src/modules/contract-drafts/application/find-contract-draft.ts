import { NotFoundException } from '@nestjs/common';
import type { ContractDraft } from '../domain/entities';
import type { ContractDraftsRepositoryInterface } from '../domain/ports';

export async function findContractDraft(
  repository: ContractDraftsRepositoryInterface,
  id: string,
): Promise<ContractDraft> {
  const draft = await repository.findById(id);

  if (!draft) {
    throw new NotFoundException({
      code: 'CONTRACT_DRAFT_NOT_FOUND',
      message: 'Contract draft not found',
    });
  }

  return draft;
}
