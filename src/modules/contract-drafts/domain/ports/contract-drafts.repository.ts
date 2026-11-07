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

  /**
   * Grava a conversão só se a minuta ainda não tem contrato. `false` quando
   * outra conversão simultânea gravou antes — com a mesma chave, o produto
   * devolveu às duas o mesmo contrato, e só a primeira audita (GAP-043).
   */
  abstract saveConversion(draft: ContractDraft): Promise<boolean>;
  abstract findById(id: string): Promise<ContractDraft | null>;
  abstract list(
    filter: ListContractDraftsFilter,
    page: PageParams,
  ): Promise<PageResult<ContractDraft>>;
}
