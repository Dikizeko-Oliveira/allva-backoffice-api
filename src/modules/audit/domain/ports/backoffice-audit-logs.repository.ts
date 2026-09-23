import type {
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import type { BackofficeAuditLog } from '../entities';

export type ListBackofficeAuditLogsFilter = {
  actorId?: string;
  action?: string;
  subjectId?: string;
  from?: Date;
  to?: Date;
};

export abstract class BackofficeAuditLogsRepositoryInterface {
  abstract save(log: BackofficeAuditLog): Promise<void>;
  abstract list(
    filter: ListBackofficeAuditLogsFilter,
    page: PageParams,
  ): Promise<PageResult<BackofficeAuditLog>>;
}
