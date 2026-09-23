import type {
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import type { AlertEvent } from '../entities';

export type ListAlertEventsFilter = {
  /** Só eventos cuja regra exige uma destas permissões. */
  permissions: readonly string[];
  acknowledged?: boolean;
};

export abstract class AlertEventsRepositoryInterface {
  abstract findById(id: string): Promise<AlertEvent | null>;
  abstract list(
    filter: ListAlertEventsFilter,
    page: PageParams,
  ): Promise<PageResult<AlertEvent>>;
  abstract saveAcknowledgement(event: AlertEvent): Promise<void>;
}
