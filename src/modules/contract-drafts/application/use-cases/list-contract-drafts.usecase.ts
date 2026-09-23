import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { ContractDraftsRepositoryInterface } from 'src/modules/contract-drafts/domain/ports';
import { resolvePage } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { toContractDraftOutput } from '../contract-draft.presenter';
import {
  ListContractDraftsOutputDto,
  ListContractDraftsQueryDto,
} from '../dtos';

@Injectable()
export class ListContractDraftsUseCase {
  constructor(
    private readonly draftsRepository: ContractDraftsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: ListContractDraftsQueryDto,
  ): Promise<ListContractDraftsOutputDto> {
    assertPlatformPermission(operator, 'billing:read');

    const result = await this.draftsRepository.list(
      { salesLeadId: query.salesLeadId },
      resolvePage(query),
    );

    return { ...result, items: result.items.map(toContractDraftOutput) };
  }
}
