import { SalesLead, SalesLeadStatus } from '../entities';

export type ListSalesLeadsFilter = {
  status?: SalesLeadStatus;
  assignedTo?: string;
  /** Busca por empresa, contato ou e-mail. */
  q?: string;
  source?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
};

export type ListSalesLeadsResult = {
  items: SalesLead[];
  total: number;
  page: number;
  pageSize: number;
};

export abstract class SalesLeadsRepositoryInterface {
  abstract save(salesLead: SalesLead): Promise<void>;
  abstract update(salesLead: SalesLead): Promise<void>;
  abstract findById(id: string): Promise<SalesLead | null>;
  abstract list(filter: ListSalesLeadsFilter): Promise<ListSalesLeadsResult>;
}
