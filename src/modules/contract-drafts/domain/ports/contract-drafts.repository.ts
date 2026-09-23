import type {
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import type { ContractDraft } from '../entities';

export type ListContractDraftsFilter = {
  salesLeadId?: string;
};

export abstract class ContractDraftsRepositoryInterface {
  abstract save(draft: ContractDraft): Promise<void>;
  abstract update(draft: ContractDraft): Promise<void>;
  abstract findById(id: string): Promise<ContractDraft | null>;
  abstract list(
    filter: ListContractDraftsFilter,
    page: PageParams,
  ): Promise<PageResult<ContractDraft>>;
}
